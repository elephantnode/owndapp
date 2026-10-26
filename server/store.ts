import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exposureLabels, lifecycleLabels, responseLabels, type AppRole, type Advisory, type Exposure, type ResponseRecord, type ResponseStatus, type Candidate, type Dependency, type DependencySnapshot, type Ecosystem, type GitObservation, type Lifecycle, type VulnerabilityCheck, type OpenApp, type OpenApps, type Project, type ProjectEdit, type Scan } from '../shared/types.js';
import { dependencyContentId } from './dependency-content.js';
import { normalizePython } from './python-locks.js';

export class CatalogError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type DependencyRow = { project_id: string; ecosystem: Ecosystem; name: string; version: string | null; requested: string | null; direct: number;
  scope: Dependency['scope']; source: Dependency['source']; file: string; component: string };
const toDependency = ({ project_id: _, direct, ...row }: DependencyRow): Dependency => ({ ...row, direct: direct === 1 });

const judged = (check: VulnerabilityCheck) => check.queried > 0 || check.failed > 0 || check.findings.length > 0;

// Archiving keeps the lifecycle it replaced, so leaving the archive can restore it.
function rememberArchive(current: Project, next: Project) {
  if (next.lifecycle !== 'archived') delete next.archivedFrom;
  else if (current.lifecycle !== 'archived') next.archivedFrom = current.lifecycle;
}

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) throw new Error('このデータベースは新しいowndappで作成されています');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
        lifecycle TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_lifecycle ON projects(lifecycle);
      CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        action TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS removals (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, removed_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exclusions (path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_roots (path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS responses (
        project_id TEXT NOT NULL REFERENCES projects(id), advisory_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (project_id, advisory_id)
      );
      CREATE TABLE IF NOT EXISTS dependency_snapshots (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), read_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dependencies (
        project_id TEXT NOT NULL REFERENCES projects(id), ecosystem TEXT NOT NULL, name TEXT NOT NULL, version TEXT, requested TEXT,
        direct INTEGER NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL, file TEXT NOT NULL, component TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dependencies_name ON dependencies(ecosystem, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS dependencies_project ON dependencies(project_id);
      CREATE TABLE IF NOT EXISTS vulnerability_checks (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), checked_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS git_observations (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), read_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    for (const scan of this.scans()) {
      if (scan.status === 'running' && !scan.persistent) {
        scan.status = 'cancelled'; scan.endedAt = new Date().toISOString();
        scan.issues.push({ path: scan.root, message: 'サーバーの再起動で探索が中断されました。再探索してください' });
        this.saveScan(scan);
      }
    }
    // Folders scanned before scan folders were kept become the first registered ones, once.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='scanRoots.seeded'").get()) {
      const roots = this.db.prepare("SELECT DISTINCT json_extract(payload, '$.root') AS root, min(json_extract(payload, '$.startedAt')) AS at FROM scans GROUP BY root").all() as { root: string; at: string }[];
      for (const { root, at } of roots) if (root) this.db.prepare('INSERT INTO scan_roots VALUES(?, ?) ON CONFLICT(path) DO NOTHING').run(root, at || new Date().toISOString());
      this.db.prepare("INSERT INTO settings VALUES('scanRoots.seeded', 'true')").run();
    }
  }
  close() { this.db.close(); }
  /** Folders registered for scanning, in the order they were added. */
  scanRoots(): { path: string; createdAt: string }[] {
    return this.db.prepare('SELECT path, created_at AS createdAt FROM scan_roots ORDER BY created_at, path').all() as { path: string; createdAt: string }[];
  }
  addScanRoot(path: string) {
    if (this.scanRoots().length >= 200) throw new CatalogError('探索フォルダは200件までです');
    this.db.prepare('INSERT INTO scan_roots VALUES(?, ?) ON CONFLICT(path) DO NOTHING').run(path, new Date().toISOString());
  }
  removeScanRoot(path: string) { this.db.prepare('DELETE FROM scan_roots WHERE path=?').run(path); }
  /** Any saved scan, including ones older than the ten loaded at start. */
  scan(id: string): Scan | null {
    const row = this.db.prepare('SELECT payload FROM scans WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  latestScan(root: string): Scan | null {
    const row = this.db.prepare("SELECT payload FROM scans WHERE json_extract(payload, '$.root')=? ORDER BY rowid DESC LIMIT 1").get(root) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  projects(): Project[] {
    return (this.db.prepare('SELECT payload FROM projects ORDER BY rowid DESC').all() as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT payload FROM projects WHERE id = ?').get(id) as { payload: string } | undefined;
    if (!row) throw new CatalogError('プロジェクトが見つかりません', 404);
    return JSON.parse(row.payload);
  }
  paths() { return new Set(this.projects().map(p => p.path)); }
  scans(): Scan[] {
    return (this.db.prepare('SELECT payload FROM scans ORDER BY rowid DESC LIMIT 10').all() as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  saveScan(scan: Scan) {
    this.db.prepare('INSERT INTO scans(id, payload) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(scan.id, JSON.stringify(scan));
  }
  previousImport(id: string): { id: string; projectIds: string[] } | null {
    const row = this.db.prepare('SELECT payload FROM imports WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  import(id: string, candidates: Candidate[]) {
    const previous = this.previousImport(id);
    if (previous) return previous;
    if (!candidates.length) throw new CatalogError('登録する候補を選んでください');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const paths = this.paths();
      const now = new Date().toISOString();
      const projectIds: string[] = [];
      for (const candidate of candidates) {
        if (paths.has(candidate.path)) throw new CatalogError('既に登録された場所が含まれています。候補を更新してください', 409);
        paths.add(candidate.path);
        const project: Project = { ...candidate, id: randomUUID(), registered: true, purpose: '', tags: [], notes: '', lifecycle: 'untriaged',
          archiveReason: '', archivedAt: null, createdAt: now, observedAt: now, revision: 1, importBatch: id };
        this.db.prepare('INSERT INTO projects VALUES(?, ?, ?, ?, ?)').run(project.id, project.path, 1, project.lifecycle, JSON.stringify(project));
        this.history(project.id, 'registered', { lifecycle: project.lifecycle });
        projectIds.push(project.id);
      }
      const result = { id, projectIds };
      this.db.prepare('INSERT INTO imports VALUES(?, ?)').run(id, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  edit(id: string, input: ProjectEdit) {
    const current = this.project(id);
    if (input.revision !== current.revision) throw new CatalogError('別の画面で変更されています。入力を残したまま最新の内容を読み直してください', 409);
    if (!input.name?.trim() || input.name.length > 200) throw new CatalogError('名前は1〜200文字で入力してください');
    if (!Object.hasOwn(lifecycleLabels, input.lifecycle)) throw new CatalogError('管理状態を確認してください');
    if (input.exposure !== undefined && !Object.hasOwn(exposureLabels, input.exposure)) throw new CatalogError('公開状況を確認してください');
    const next: Project = { ...current, ...input, name: input.name.trim(), tags: [...new Set(input.tags.map(t => t.trim()).filter(Boolean))], revision: current.revision + 1,
      archivedAt: input.lifecycle === 'archived' ? current.archivedAt || new Date().toISOString() : null };
    // An edited purpose is the user's own words from then on.
    if (input.purpose !== current.purpose) delete next.purposeSource;
    rememberArchive(current, next);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE projects SET revision=?, lifecycle=?, payload=? WHERE id=? AND revision=?')
        .run(next.revision, next.lifecycle, JSON.stringify(next), id, current.revision);
      if (result.changes !== 1) throw new CatalogError('変更が競合しました。最新の内容を読み直してください', 409);
      this.history(id, 'edited', { from: current.lifecycle, to: next.lifecycle, reason: next.archiveReason });
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addTags(ids: string[], tags: string[]) {
    const selected = [...new Set(ids)].map(id => this.project(id));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const current of selected) {
        const next = { ...current, tags: [...new Set([...current.tags, ...tags.map(t => t.trim()).filter(Boolean)])], revision: current.revision + 1 };
        if (next.tags.length > 30) throw new CatalogError('タグはプロジェクトごとに30個までです');
        this.db.prepare('UPDATE projects SET revision=?, payload=? WHERE id=?').run(next.revision, JSON.stringify(next), next.id);
        this.history(current.id, 'tags_added', { tags });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Archiving needs a reason, as in edit. Leaving the archive keeps the earlier reason, also as in edit.
  setLifecycle(ids: string[], lifecycle: Lifecycle, archiveReason = '') {
    if (!Object.hasOwn(lifecycleLabels, lifecycle)) throw new CatalogError('管理状態を確認してください');
    const selected = [...new Set(ids)].map(id => this.project(id));
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const current of selected) {
        if (current.lifecycle === lifecycle && lifecycle !== 'archived') continue;
        const next: Project = { ...current, lifecycle, revision: current.revision + 1,
          archiveReason: lifecycle === 'archived' ? archiveReason.trim() : current.archiveReason,
          archivedAt: lifecycle === 'archived' ? current.archivedAt || now : null };
        rememberArchive(current, next);
        this.db.prepare('UPDATE projects SET revision=?, lifecycle=?, payload=? WHERE id=?').run(next.revision, next.lifecycle, JSON.stringify(next), next.id);
        this.history(current.id, 'lifecycle_changed', { from: current.lifecycle, to: lifecycle, reason: next.archiveReason });
      }
      this.db.exec('COMMIT'); return selected.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setExposure(ids: string[], exposure: Exposure) {
    if (!Object.hasOwn(exposureLabels, exposure)) throw new CatalogError('公開状況を確認してください');
    const selected = [...new Set(ids)].map(id => this.project(id));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const current of selected) {
        if ((current.exposure ?? 'unknown') === exposure) continue;
        const next: Project = { ...current, exposure, revision: current.revision + 1 };
        this.db.prepare('UPDATE projects SET revision=?, payload=? WHERE id=?').run(next.revision, JSON.stringify(next), next.id);
        this.history(current.id, 'exposure_changed', { from: current.exposure ?? 'unknown', to: exposure });
      }
      this.db.exec('COMMIT'); return selected.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  responses(projectId?: string): ResponseRecord[] {
    const rows = (projectId ? this.db.prepare('SELECT payload FROM responses WHERE project_id=?').all(projectId) : this.db.prepare('SELECT payload FROM responses').all()) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
  private saveResponse(record: ResponseRecord) {
    this.db.prepare('INSERT INTO responses VALUES(?, ?, ?, ?) ON CONFLICT(project_id, advisory_id) DO UPDATE SET status=excluded.status, payload=excluded.payload')
      .run(record.projectId, record.advisoryId, record.status, JSON.stringify(record));
  }
  /**
   * Sets how known vulnerabilities are handled. resolved cannot be set by hand: only a later check that no longer finds
   * the advisory resolves it. not-applicable needs a reason. advisory snapshots come from the current check.
   * preserveNotes keeps each advisory's own note; the given note then only goes into the history entry.
   */
  setResponses(items: { projectId: string; advisory: ResponseRecord['advisory'] }[], status: ResponseStatus, note = '', reviewBy: string | null = null, preserveNotes = false) {
    if (!Object.hasOwn(responseLabels, status) || status === 'resolved') throw new CatalogError('対応状況を確認してください。解消確認は再照会で自動的に付きます');
    if (status === 'not-applicable' && !note.trim()) throw new CatalogError('対象外にする根拠を入力してください');
    if (reviewBy !== null && !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) throw new CatalogError('見直す日付を確認してください');
    const existing = new Map(this.responses().map(r => [`${r.projectId}\0${r.advisoryId}`, r]));
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        this.project(item.projectId);
        const current = existing.get(`${item.projectId}\0${item.advisory.id}`);
        const record: ResponseRecord = { projectId: item.projectId, advisoryId: item.advisory.id, status, note: preserveNotes ? current?.note ?? '' : note.trim(), reviewBy: status === 'not-applicable' ? reviewBy : null,
          updatedAt: now, resolvedAt: null, advisory: item.advisory, history: [...(current?.history ?? []), { at: now, status, note: note.trim() || undefined, by: 'user' }] };
        this.saveResponse(record);
      }
      this.db.exec('COMMIT'); return items.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * Called after a complete check. Advisories that were found before and are gone now are resolved, whether or not anyone
   * recorded a response; a resolved advisory that is found again is reopened.
   */
  reconcileResponses(projectId: string, previous: Map<string, ResponseRecord['advisory']>, current: Map<string, ResponseRecord['advisory']>) {
    const now = new Date().toISOString();
    const records = new Map(this.responses(projectId).map(r => [r.advisoryId, r]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id, advisory] of [...previous, ...[...records].map(([rid, r]) => [rid, r.advisory] as const)]) {
        const record = records.get(id);
        if (current.has(id) || record?.status === 'resolved') continue;
        const next: ResponseRecord = { projectId, advisoryId: id, status: 'resolved', note: record?.note ?? '', reviewBy: null, updatedAt: now, resolvedAt: now,
          advisory: record?.advisory ?? advisory, history: [...(record?.history ?? []), { at: now, status: 'resolved', note: '再照会で検出されなくなりました', by: 'recheck' }] };
        this.saveResponse(next); records.set(id, next);
      }
      for (const [id, advisory] of current) {
        const record = records.get(id);
        if (record?.status !== 'resolved') continue;
        this.saveResponse({ ...record, status: 'open', resolvedAt: null, updatedAt: now, advisory,
          history: [...record.history, { at: now, status: 'open', note: '再照会で再び検出されました', by: 'recheck' }] });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Fills empty purposes only. A purpose the user wrote, or one filled meanwhile, is never replaced. Returns the ids filled. */
  fillPurposes(entries: { id: string; text: string; source: string }[]) {
    const filled: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const current = this.project(entry.id);
        if (current.purpose.trim()) continue;
        const next: Project = { ...current, purpose: entry.text, purposeSource: entry.source, revision: current.revision + 1 };
        this.db.prepare('UPDATE projects SET revision=?, payload=? WHERE id=?').run(next.revision, JSON.stringify(next), next.id);
        this.history(current.id, 'purpose_filled', { source: entry.source });
        filled.push(entry.id);
      }
      this.db.exec('COMMIT'); return filled;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Removes projects from the catalog only. The project and its history are kept in removals for reference.
  remove(ids: string[], reason: string) {
    const selected = [...new Set(ids)].map(id => this.project(id));
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const project of selected) {
        const history = this.db.prepare('SELECT action, created_at as createdAt, payload FROM history WHERE project_id=? ORDER BY rowid').all(project.id);
        // Dependencies can be read again from the folder, so only the time of the last read is kept.
        const dependenciesReadAt = (this.db.prepare('SELECT read_at FROM dependency_snapshots WHERE project_id=?').get(project.id) as { read_at: string } | undefined)?.read_at ?? null;
        // Known vulnerabilities found at removal are kept, so a removed project's last known exposure stays on record.
        const vulnerabilities = this.vulnerabilityCheck(project.id);
        const responses = this.responses(project.id);
        this.db.prepare('INSERT INTO removals VALUES(?, ?, ?, ?, ?)').run(randomUUID(), project.id, project.path, now, JSON.stringify({ reason, project, history, dependenciesReadAt,
          vulnerabilities: vulnerabilities && { checkedAt: vulnerabilities.checkedAt, ids: [...new Set(vulnerabilities.findings.flatMap(f => f.advisories.map(a => a.id)))] },
          responses: responses.length ? responses : undefined }));
        this.db.prepare('DELETE FROM history WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM dependencies WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM dependency_snapshots WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM vulnerability_checks WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM git_observations WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM responses WHERE project_id=?').run(project.id);
        this.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
      }
      this.db.exec('COMMIT'); return selected.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  removals() {
    return (this.db.prepare('SELECT project_id as projectId, path, removed_at as removedAt, payload FROM removals ORDER BY rowid DESC').all() as { projectId: string; path: string; removedAt: string; payload: string }[]);
  }
  // Replaces the project's dependencies, so rows from an earlier read never remain as current.
  saveDependencies(snapshot: DependencySnapshot, dependencies: Dependency[]) {
    this.project(snapshot.projectId);
    const previous = this.dependencies(snapshot.projectId);
    const contentId = dependencyContentId(snapshot, dependencies);
    snapshot = { ...snapshot, contentId };
    const check = this.vulnerabilityCheck(snapshot.projectId);
    // Upgrade a legacy check only when its original snapshot is still known.
    // Already-stale legacy results must remain stale until checked again.
    const legacyMatch = check && !check.snapshotContentId && previous.snapshot &&
      check.snapshotReadAt === previous.snapshot.readAt &&
      dependencyContentId(previous.snapshot, previous.dependencies) === contentId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM dependencies WHERE project_id=?').run(snapshot.projectId);
      const insert = this.db.prepare('INSERT INTO dependencies VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const d of dependencies) insert.run(snapshot.projectId, d.ecosystem, d.name, d.version, d.requested, d.direct ? 1 : 0, d.scope, d.source, d.file, d.component);
      this.db.prepare('INSERT INTO dependency_snapshots VALUES(?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET read_at=excluded.read_at, status=excluded.status, payload=excluded.payload')
        .run(snapshot.projectId, snapshot.readAt, snapshot.status, JSON.stringify(snapshot));
      if (legacyMatch) {
        this.db.prepare('UPDATE vulnerability_checks SET payload=? WHERE project_id=?')
          .run(JSON.stringify({ ...check, snapshotContentId: contentId }), snapshot.projectId);
      }
      this.history(snapshot.projectId, 'dependencies_read', { status: snapshot.status, total: snapshot.total, direct: snapshot.direct });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dependencySnapshots(): Map<string, DependencySnapshot> {
    const rows = this.db.prepare('SELECT payload FROM dependency_snapshots').all() as { payload: string }[];
    return new Map(rows.map(row => { const snapshot = JSON.parse(row.payload) as DependencySnapshot; return [snapshot.projectId, snapshot]; }));
  }
  dependencies(projectId: string): { snapshot: DependencySnapshot | null; dependencies: Dependency[] } {
    this.project(projectId);
    const row = this.db.prepare('SELECT payload FROM dependency_snapshots WHERE project_id=?').get(projectId) as { payload: string } | undefined;
    const rows = this.db.prepare('SELECT * FROM dependencies WHERE project_id=? ORDER BY direct DESC, name, version').all(projectId) as DependencyRow[];
    return { snapshot: row ? JSON.parse(row.payload) : null, dependencies: rows.map(toDependency) };
  }
  /**
   * Name matching in every ecosystem, ignoring case; exact by default for existing API clients. Python names also match in their PEP 503 form, so python_dateutil finds python-dateutil.
   * version, when given, must match the resolved version exactly.
   */
  searchDependencies(name: string, version?: string, match: 'exact' | 'contains' = 'exact') {
    // instr treats %, _ and backslashes literally, unlike LIKE patterns.
    const where = match === 'contains'
      ? "(instr(lower(name), lower(?)) > 0 OR (ecosystem='PyPI' AND instr(name, ?) > 0))"
      : "(name=? COLLATE NOCASE OR (ecosystem='PyPI' AND name=?))";
    const rows = (version
      ? this.db.prepare(`SELECT * FROM dependencies WHERE ${where} AND version=? ORDER BY project_id, direct DESC, ecosystem, version`).all(name, normalizePython(name), version)
      : this.db.prepare(`SELECT * FROM dependencies WHERE ${where} ORDER BY project_id, direct DESC, ecosystem, version`).all(name, normalizePython(name))) as DependencyRow[];
    const grouped = new Map<string, Dependency[]>();
    for (const row of rows) grouped.set(row.project_id, [...(grouped.get(row.project_id) || []), toDependency(row)]);
    return grouped;
  }
  saveVulnerabilityCheck(check: VulnerabilityCheck) {
    this.project(check.projectId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO vulnerability_checks VALUES(?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET checked_at=excluded.checked_at, status=excluded.status, payload=excluded.payload')
        .run(check.projectId, check.checkedAt, check.status, JSON.stringify(check));
      this.history(check.projectId, 'vulnerabilities_checked', { status: check.status, queried: check.queried, failed: check.failed,
        advisories: [...new Set(check.findings.flatMap(f => f.advisories.map(a => a.id)))] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Checks that sent nothing were stored by earlier versions; they judged nothing, so they read as no check at all.
  vulnerabilityCheck(projectId: string): VulnerabilityCheck | null {
    const row = this.db.prepare('SELECT payload FROM vulnerability_checks WHERE project_id=?').get(projectId) as { payload: string } | undefined;
    const check = row ? JSON.parse(row.payload) as VulnerabilityCheck : null;
    return check && judged(check) ? check : null;
  }
  vulnerabilityChecks(): Map<string, VulnerabilityCheck> {
    const rows = this.db.prepare('SELECT payload FROM vulnerability_checks').all() as { payload: string }[];
    return new Map(rows.map(row => JSON.parse(row.payload) as VulnerabilityCheck).filter(judged).map(check => [check.projectId, check]));
  }
  // Replaces the project's last Git read. A failed API call leaves the previous row untouched.
  saveGit(observation: GitObservation) {
    this.project(observation.projectId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO git_observations VALUES(?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET read_at=excluded.read_at, status=excluded.status, payload=excluded.payload')
        .run(observation.projectId, observation.readAt, observation.status, JSON.stringify(observation));
      this.history(observation.projectId, 'git_read', { status: observation.status, remotes: observation.remotes.length, branch: observation.branch });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  gitObservation(projectId: string): GitObservation | null {
    this.project(projectId);
    const row = this.db.prepare('SELECT payload FROM git_observations WHERE project_id=?').get(projectId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as GitObservation : null;
  }
  gitObservations(): Map<string, GitObservation> {
    const rows = this.db.prepare('SELECT payload FROM git_observations').all() as { payload: string }[];
    return new Map(rows.map(row => { const observation = JSON.parse(row.payload) as GitObservation; return [observation.projectId, observation]; }));
  }
  /** Distinct packages per ecosystem, most used first. filter matches part of the name, ignoring case. Versions are sorted by the caller. */
  dependencyPackages(filter: string, limit: number) {
    const pattern = `%${filter.replace(/[\\%_]/g, '\\$&')}%`;
    const where = "name LIKE ? ESCAPE '\\' AND project_id IN (SELECT id FROM projects)";
    const total = (this.db.prepare(`SELECT COUNT(DISTINCT ecosystem || ':' || lower(name)) AS count FROM dependencies WHERE ${where}`).get(pattern) as { count: number }).count;
    const rows = this.db.prepare(`SELECT ecosystem, min(name) AS name, COUNT(DISTINCT project_id) AS projects,
        COUNT(DISTINCT CASE WHEN direct=1 THEN project_id END) AS directProjects, json_group_array(DISTINCT version) AS versions
      FROM dependencies WHERE ${where} GROUP BY ecosystem, lower(name) ORDER BY projects DESC, lower(name), ecosystem LIMIT ?`).all(pattern, limit) as
      { ecosystem: Ecosystem; name: string; projects: number; directProjects: number; versions: string }[];
    return { total, packages: rows.map(row => ({ ...row, versions: (JSON.parse(row.versions) as (string | null)[]).filter((v): v is string => !!v) })) };
  }
  // Applications used to open project folders, one per role.
  apps(): OpenApps {
    const rows = this.db.prepare("SELECT key, payload FROM settings WHERE key IN ('app.editor', 'app.terminal')").all() as { key: string; payload: string }[];
    const found = new Map(rows.map(row => [row.key, JSON.parse(row.payload) as OpenApp]));
    return { editor: found.get('app.editor') || null, terminal: found.get('app.terminal') || null };
  }
  setApp(role: AppRole, app: OpenApp | null) {
    if (!app) { this.db.prepare('DELETE FROM settings WHERE key=?').run(`app.${role}`); return; }
    this.db.prepare('INSERT INTO settings VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(`app.${role}`, JSON.stringify(app));
  }
  // Folders skipped by every scan, including their subfolders. Paths are canonical and absolute.
  exclusions(): string[] {
    return (this.db.prepare('SELECT path FROM exclusions ORDER BY path').all() as { path: string }[]).map(row => row.path);
  }
  // All or none: several folders excluded from the catalog are added together, within the limit.
  addExclusions(paths: string[]) {
    const current = new Set(this.exclusions()); const added = [...new Set(paths)].filter(path => !current.has(path));
    if (current.size + added.length > 200) throw new CatalogError('除外するフォルダは200件までです');
    const now = new Date().toISOString(); const insert = this.db.prepare('INSERT INTO exclusions VALUES(?, ?) ON CONFLICT(path) DO NOTHING');
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const path of added) insert.run(path, now); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  removeExclusion(path: string) { this.db.prepare('DELETE FROM exclusions WHERE path=?').run(path); }
  private history(projectId: string, action: string, payload: object) {
    this.db.prepare('INSERT INTO history VALUES(?, ?, ?, ?, ?)').run(randomUUID(), projectId, action, new Date().toISOString(), JSON.stringify(payload));
  }
  getHistory(id: string) {
    this.project(id);
    return this.db.prepare('SELECT action, created_at as createdAt, payload FROM history WHERE project_id=? ORDER BY rowid DESC LIMIT 30').all(id);
  }
}
