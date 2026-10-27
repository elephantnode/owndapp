import { ScanJobs } from './scan-jobs.js';
import { inspectGuard, applyGuard } from './guard.js';
import { basename, isAbsolute, sep } from 'node:path';
import { Hono } from 'hono';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { Store, CatalogError } from './store.js';
import { canonicalRoot, isExcluded, within, revalidateCandidate } from './scanner.js';
import { realpath, stat } from 'node:fs/promises';
import { dependencyStatusOf, filesChanged, readDependencies as readLockfiles } from './dependencies.js';
import { readGit } from './git.js';
import { suggestPurpose } from './readme.js';
import { osvApi, type OsvClient, type RunOptions } from './osv.js';
import { check as checkVulnerabilities, preview as previewVulnerabilities, snapshots as vulnerabilitySnapshots, summarize, type CheckPhase } from './vulnerabilities.js';
import { priorityOf, priorityReasons, severityRank } from '../shared/priority.js';
import { chooseApplication, chooseFolder, openInFinder, openWithApp, type AppOpener, type AppPicker, type FolderOpener, type FolderPicker } from './folder-picker.js';
import { appRoleLabels, readFileStatuses, type Advisory, type AppRole, type Candidate, type Dependency, type DependencySnapshot, type Exposure, type GitStatus, type Lifecycle, type ProjectEdit, type QueueItem, type ResponseRecord, type ResponseStatus, type Scan } from '../shared/types.js';

const bulkLimit = 1000; // 1000 ids stay within the 64KB request limit.

export type VulnerabilityJob = { id: string; status: 'running' | 'done' | 'failed'; phase: 'reading' | CheckPhase; done: number; total: number;
  projects: number; read: number; startedAt: string; finishedAt?: string; result?: Awaited<ReturnType<typeof checkVulnerabilities>>; error?: string };

export function createApi(store: Store, port = 4310, pickFolder: FolderPicker = chooseFolder, openFolder: FolderOpener = openInFinder,
  { pickApp = chooseApplication, openApp = openWithApp, osv = osvApi, osvOptions = {}, platform = process.platform }: { pickApp?: AppPicker; openApp?: AppOpener; osv?: OsvClient; osvOptions?: RunOptions; platform?: NodeJS.Platform } = {}) {
  const nativeDesktop = platform === 'darwin';
  const capabilities = { platform, folderPicker: nativeDesktop, revealFolder: nativeDesktop, externalApps: nativeDesktop };
  const requireDesktop = () => { if (!nativeDesktop) throw new CatalogError('このOSではフォルダ選択・外部アプリ起動は利用できません。フォルダはパスを直接入力してください', 501); };
  const app = new Hono();
  const token = randomBytes(32).toString('hex');
  const jobs = new ScanJobs(store.db);
  const scanTasks = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let picking = false;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!allowedHosts.has(c.req.header('host') || '')) return c.json({ error: 'ローカル接続のみ利用できます' }, 403);
    const origin = c.req.header('origin');
    if (origin && ![...allowedHosts].some(host => origin === `http://${host}`)) return c.json({ error: '接続元を確認してください' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site' || c.req.header('x-owndapp-client') !== 'web') return c.json({ error: 'アプリの画面から操作してください' }, 403);
    if (c.req.path !== '/api/session') {
      const provided = Buffer.from(c.req.header('x-owndapp-token') || '');
      const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return c.json({ error: '接続が更新されました。画面を再読み込みしてください' }, 401);
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON形式で送信してください' }, 415);
      const body = await c.req.text();
      if (Buffer.byteLength(body) > 64 * 1024) return c.json({ error: '入力が大きすぎます' }, 413);
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof CatalogError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ error: '入力の形式を確認してください' }, 400);
    return c.json({ error: '処理できませんでした。入力やアクセス権を確認してください' }, 500);
  });
  app.get('/api/session', c => c.json({ token, version: '0.1.0', home: process.cwd(), capabilities }));
  // Only "no such file" counts as missing. Permission errors or other failures leave the project as is.
  const missing = (path: string) => stat(path).then(info => !info.isDirectory(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR');
  app.get('/api/projects', async c => {
    const projects = store.projects();
    const flags = await Promise.all(projects.map(project => missing(project.path)));
    const exclusions = store.exclusions();
    const snapshots = store.dependencySnapshots();
    const checks = store.vulnerabilityChecks();
    const git = store.gitObservations();
    return c.json({ projects: projects.map((project, i) => {
      const snapshot = snapshots.get(project.id); const check = checks.get(project.id); const observation = git.get(project.id);
      // Recompute so older catalogs that marked "lockなし" as partial stop counting as read failures.
      const dependencyStatus = snapshot ? dependencyStatusOf(snapshot.files) : undefined;
      return { ...project, missing: flags[i], excluded: !!isExcluded(exclusions, project.path), dependencyStatus, dependencyUnsupported: snapshot?.files.filter(file => file.status === 'unsupported').length ?? 0, dependenciesReadAt: snapshot?.readAt,
        gitStatus: observation?.status, gitReadAt: observation?.readAt,
        gitRemoteCount: observation?.status === 'ok' ? observation.remotes.length : undefined,
        gitBranch: observation?.status === 'ok' ? observation.branch : undefined,
        gitDetached: observation?.status === 'ok' ? observation.detached : undefined,
        vulnerabilities: check && summarize(check, snapshot?.readAt, snapshot?.contentId) };
    }) });
  });
  app.post('/api/projects/remove-missing', async c => {
    const input = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 2000 || input.ids.some(id => typeof id !== 'string')) throw new CatalogError('外すプロジェクトを選んでください');
    const projects = [...new Set(input.ids)].map(id => store.project(id));
    const present = (await Promise.all(projects.map(async project => await missing(project.path) ? null : project.path))).filter(Boolean);
    if (present.length) throw new CatalogError(`フォルダが存在するプロジェクトは外せません: ${present.slice(0, 3).join('、')}${present.length > 3 ? ' ほか' : ''}`, 409);
    return c.json({ removed: store.remove(projects.map(project => project.id), 'フォルダが見つからないため') });
  });
  // Checks the exclusions again right before removing, in case one was removed in another tab.
  app.post('/api/projects/remove-excluded', async c => {
    const input = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 2000 || input.ids.some(id => typeof id !== 'string')) throw new CatalogError('外すプロジェクトを選んでください');
    const projects = [...new Set(input.ids)].map(id => store.project(id));
    const exclusions = store.exclusions();
    const outside = projects.filter(project => !isExcluded(exclusions, project.path)).map(project => project.path);
    if (outside.length) throw new CatalogError(`除外設定のフォルダにないプロジェクトは外せません: ${outside.slice(0, 3).join('、')}${outside.length > 3 ? ' ほか' : ''}`, 409);
    return c.json({ removed: store.remove(projects.map(project => project.id), '除外設定のフォルダにあるため') });
  });
  // Reads one project's lockfiles and replaces its dependency rows. A missing folder or an error leaves the previous read as is.
  const readDependencies = async (id: string): Promise<DependencySnapshot['status'] | 'missing' | 'error'> => {
    try {
      const project = store.project(id);
      if (await missing(project.path)) return 'missing';
      const read = await readLockfiles(project);
      store.saveDependencies({ projectId: project.id, readAt: new Date().toISOString(), status: read.status, files: read.files,
        total: read.dependencies.length, direct: read.dependencies.filter(d => d.direct).length }, read.dependencies);
      return read.status;
    } catch { return 'error'; }
  };
  // Fills an empty purpose from the project's README or manifest description. Reads only; nothing leaves this Mac.
  const fillPurpose = async (id: string) => {
    try {
      const project = store.project(id);
      if (project.purpose.trim() || await missing(project.path)) return false;
      const suggestion = await suggestPurpose(project.path);
      return !!suggestion && store.fillPurposes([{ id, ...suggestion }]).length > 0;
    } catch { return false; }
  };
  // Newly registered projects get their purpose filled before their dependencies are read.
  const purposeQueue = new Set<string>();
  // A background queue for reads that should not hold up a response, such as right after registering projects.
  const queue: string[] = [];
  let queued = 0, finished = 0, draining = false;
  const dependencyProgress = () => ({ running: draining, done: finished, total: queued });
  const drain = async () => {
    draining = true;
    try {
      for (let id = queue.shift(); id; id = queue.shift()) {
        if (purposeQueue.delete(id)) await fillPurpose(id);
        await readDependencies(id); finished++;
        await new Promise<void>(resolve => setImmediate(resolve)); // Keep the API responsive between projects.
      }
    } finally { draining = false; queued = 0; finished = 0; }
  };
  const enqueueDependencies = (ids: string[]) => {
    const added = [...new Set(ids)].filter(id => !queue.includes(id));
    queue.push(...added); queued += added.length;
    if (!draining) void drain();
    return added.length;
  };
  // Reads lockfiles one project at a time. A failure is recorded for that project and never stops the others.
  app.post('/api/dependencies/read', async c => {
    const input = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string')) throw new CatalogError(`依存情報を読むプロジェクトを${bulkLimit}件まで選んでください`);
    const projects = [...new Set(input.ids)].map(id => store.project(id));
    const results = [];
    for (const project of projects) results.push({ id: project.id, name: project.name, status: await readDependencies(project.id) });
    return c.json({ results });
  });
  // Reads branch and remotes from .git on this Mac. Nothing is sent anywhere; fetch/status are not run.
  const readProjectGit = async (id: string): Promise<GitStatus | 'missing' | 'error'> => {
    try {
      const project = store.project(id);
      if (await missing(project.path)) return 'missing';
      const observation = { ...await readGit(project.id, project.path), readAt: new Date().toISOString() };
      store.saveGit(observation);
      return observation.status;
    } catch { return 'error'; }
  };
  app.post('/api/git/read', async c => {
    const input = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string')) throw new CatalogError(`Git情報を読むプロジェクトを${bulkLimit}件まで選んでください`);
    const projects = [...new Set(input.ids)].map(id => store.project(id));
    const results = [];
    for (const project of projects) results.push({ id: project.id, name: project.name, status: await readProjectGit(project.id) });
    return c.json({ results });
  });
  app.get('/api/projects/:id/git', c => c.json({ observation: store.gitObservation(c.req.param('id')) }));
  // Background queue for catalog-wide Git reads. Kept apart from dependency reads so either can run without blocking the other.
  const gitQueue: string[] = [];
  let gitQueued = 0, gitFinished = 0, gitDraining = false;
  const gitProgress = () => ({ running: gitDraining, done: gitFinished, total: gitQueued });
  const drainGit = async () => {
    gitDraining = true;
    try {
      for (let id = gitQueue.shift(); id; id = gitQueue.shift()) {
        await readProjectGit(id); gitFinished++;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { gitDraining = false; gitQueued = 0; gitFinished = 0; }
  };
  const enqueueGit = (ids: string[]) => {
    const added = [...new Set(ids)].filter(id => !gitQueue.includes(id));
    gitQueue.push(...added); gitQueued += added.length;
    if (!gitDraining) void drainGit();
    return added.length;
  };
  // Reads every project that is not archived, in the background. Files only; nothing is sent anywhere.
  app.post('/api/git/read-all', async c => {
    await c.req.json().catch(() => ({}));
    const ids = store.projects().filter(project => project.lifecycle !== 'archived').map(project => project.id);
    return c.json({ queued: enqueueGit(ids), progress: gitProgress() });
  });
  app.get('/api/git/progress', c => c.json(gitProgress()));
  // Reads every project that is not archived, in the background. Reading stays on this Mac; nothing is sent anywhere.
  app.post('/api/dependencies/read-all', async c => {
    await c.req.json().catch(() => ({}));
    const ids = store.projects().filter(project => project.lifecycle !== 'archived').map(project => project.id);
    return c.json({ queued: enqueueDependencies(ids), progress: dependencyProgress() });
  });
  app.get('/api/dependencies/progress', c => c.json(dependencyProgress()));
  // Fills empty purposes of the given projects, or of every project that is not archived.
  app.post('/api/purposes/fill', async c => {
    const input = await c.req.json<{ ids?: string[] }>();
    if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string'))) throw new CatalogError('対象のプロジェクトを確認してください');
    const targets = (input.ids ? [...new Set(input.ids)].map(id => store.project(id)) : store.projects().filter(p => p.lifecycle !== 'archived')).filter(p => !p.purpose.trim());
    let filled = 0;
    for (const project of targets) if (await fillPurpose(project.id)) filled++;
    return c.json({ checked: targets.length, filled });
  });
  app.get('/api/projects/:id/purpose-suggestion', async c => {
    const project = store.project(c.req.param('id'));
    return c.json({ suggestion: await missing(project.path) ? null : await suggestPurpose(project.path) });
  });
  app.get('/api/dependencies/search', c => {
    const name = (c.req.query('name') || '').trim(); const version = (c.req.query('version') || '').trim();
    if (!name || name.length > 214 || version.length > 256) throw new CatalogError('パッケージ名を入力してください');
    const match = c.req.query('match') || 'exact';
    if (match !== 'exact' && match !== 'contains') throw new CatalogError('名前の一致方法を確認してください');
    const snapshots = store.dependencySnapshots();
    const projects = new Map(store.projects().map(project => [project.id, project]));
    const matches = [...store.searchDependencies(name, version || undefined, match)].flatMap(([id, dependencies]) => {
      const project = projects.get(id); const snapshot = snapshots.get(id);
      return project && snapshot ? [{ project: { id, name: project.name, path: project.path, lifecycle: project.lifecycle }, readAt: snapshot.readAt, status: snapshot.status, dependencies }] : [];
    });
    const read = [...snapshots.values()].filter(snapshot => projects.has(snapshot.projectId));
    return c.json({ matches, coverage: { read: read.length, withLock: read.filter(snapshot => snapshot.files.some(file => readFileStatuses.includes(file.status))).length, total: projects.size, unsupported: read.filter(snapshot => snapshot.files.some(file => file.status === 'unsupported')).length } });
  });
  const vulnerabilityIds = async (c: { req: { json: <T>() => Promise<T> } }) => {
    const input = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string')) throw new CatalogError(`照会するプロジェクトを${bulkLimit}件まで選んでください`);
    return [...new Set(input.ids)];
  };
  // Nothing is sent here: this only counts what a check would send.
  app.post('/api/vulnerabilities/preview', async c => c.json(previewVulnerabilities(store, await vulnerabilityIds(c))));
  // A check runs in the background: first it reads dependencies that were never read or whose lockfiles changed,
  // then queries OSV in batches and fetches details in parallel. The screen follows it through /api/vulnerabilities/job.
  let job: VulnerabilityJob | null = null;
  const runCheck = async (current: VulnerabilityJob, ids: string[]) => {
    try {
      const stale: string[] = [];
      for (const id of ids) {
        const project = store.project(id); const snapshot = store.dependencySnapshots().get(id);
        if (await missing(project.path)) continue;
        // Repeat when never read, a real read failed, a lock may have appeared where there was none, or recorded files changed.
        const status = snapshot ? dependencyStatusOf(snapshot.files) : null;
        if (!snapshot || status !== 'complete' || snapshot.files.some(f => f.status === 'no-lock') || await filesChanged(project.path, snapshot.files)) stale.push(id);
      }
      Object.assign(current, { phase: 'reading', done: 0, total: stale.length });
      for (const id of stale) { await readDependencies(id); current.done++; }
      const result = await checkVulnerabilities(store, osv, ids, { ...osvOptions, onProgress: (phase, done, total) => Object.assign(current, { phase, done, total }) });
      current.read = stale.length;
      if (result.queried === 0 && result.failed > 0) Object.assign(current, { status: 'failed', error: 'OSVに接続できませんでした。ネットワークを確認してください。前回の結果は残しています' });
      else Object.assign(current, { status: 'done', result });
    } catch { Object.assign(current, { status: 'failed', error: '照会を完了できませんでした。前回の結果は残しています' }); }
    current.finishedAt = new Date().toISOString();
  };
  app.post('/api/vulnerabilities/check', async c => {
    const ids = await vulnerabilityIds(c);
    if (job?.status === 'running') throw new CatalogError('別の照会を実行中です。終わってから実行してください', 409);
    ids.forEach(id => store.project(id));
    job = { id: randomUUID(), status: 'running', phase: 'reading', done: 0, total: 0, projects: ids.length, read: 0, startedAt: new Date().toISOString() };
    void runCheck(job, ids);
    return c.json({ job }, 202);
  });
  app.get('/api/vulnerabilities/job', c => c.json({ job }));
  app.get('/api/projects/:id/vulnerabilities', c => {
    const project = store.project(c.req.param('id'));
    const check = store.vulnerabilityCheck(project.id);
    const snapshot = store.dependencySnapshots().get(project.id);
    return c.json({ check, summary: check && summarize(check, snapshot?.readAt, snapshot?.contentId) });
  });
  app.get('/api/dependencies/packages', c => {
    const filter = (c.req.query('q') || '').trim().slice(0, 214);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') || '100', 10) || 100, 1), 1000);
    return c.json(store.dependencyPackages(filter, limit));
  });
  app.get('/api/projects/:id/dependencies', async c => {
    const project = store.project(c.req.param('id'));
    const { snapshot, dependencies } = store.dependencies(project.id);
    const view = snapshot ? { ...snapshot, status: dependencyStatusOf(snapshot.files) } : null;
    return c.json({ snapshot: view, dependencies, changed: snapshot ? await filesChanged(project.path, snapshot.files) : false });
  });
  app.get('/api/projects/:id/history', c => c.json({ history: store.getHistory(c.req.param('id')) }));
  app.patch('/api/projects/:id', async c => {
    const input = await c.req.json<ProjectEdit>();
    if (typeof input.name !== 'string' || typeof input.purpose !== 'string' || typeof input.notes !== 'string' || typeof input.archiveReason !== 'string' ||
      !Array.isArray(input.tags) || input.tags.length > 30 || input.tags.some(t => typeof t !== 'string' || t.length > 80) ||
      input.purpose.length > 2000 || input.notes.length > 10000 || input.archiveReason.length > 2000 || !Number.isInteger(input.revision) ||
      (input.exposure !== undefined && typeof input.exposure !== 'string')) throw new CatalogError('入力の形式や長さを確認してください');
    return c.json({ project: store.edit(c.req.param('id'), input) });
  });
  app.post('/api/projects/exposure', async c => {
    const input = await c.req.json<{ ids: string[]; exposure: Exposure }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string') || typeof input.exposure !== 'string') throw new CatalogError('対象と公開状況を確認してください');
    store.setExposure(input.ids, input.exposure); return c.json({ projects: store.projects() });
  });
  // Every known vulnerability per project, with its response and priority. Resolved ones stay listed from their records.
  // Archived projects are omitted from the queue; ?project= still allows a detail-page memo for one archived project.
  const responseQueue = (only?: string) => {
    const checks = store.vulnerabilityChecks(); const snapshots = store.dependencySnapshots();
    const responses = new Map(store.responses().map(r => [`${r.projectId}\0${r.advisoryId}`, r]));
    const items: QueueItem[] = []; const projects: Record<string, { checkedAt: string; stale: boolean; status: string; detailsFailed: number; attemptedAt?: string }> = {};
    for (const project of store.projects()) {
      if (only ? project.id !== only : project.lifecycle === 'archived') continue;
      const check = checks.get(project.id);
      if (!check) continue;
      projects[project.id] = { checkedAt: check.checkedAt, status: check.status, detailsFailed: check.detailsFailed ?? 0, attemptedAt: check.attemptedAt, stale: summarize(check, snapshots.get(project.id)?.readAt, snapshots.get(project.id)?.contentId).stale };
      const byAdvisory = new Map<string, { advisory: Advisory; dependencies: Dependency[]; variants: { dependency: Dependency; advisory: Advisory }[]; retained: boolean }>();
      for (const finding of check.findings) for (const advisory of finding.advisories) {
        const entry = byAdvisory.get(advisory.id) ?? { advisory: { ...advisory }, dependencies: [], variants: [], retained: false };
        entry.variants.push({ dependency: finding.dependency, advisory });
        entry.retained ||= !!finding.retained || !!advisory.severityRetained;
        if (severityRank[advisory.severity] > severityRank[entry.advisory.severity]) entry.advisory = { ...advisory };
        entry.dependencies.push(finding.dependency); byAdvisory.set(advisory.id, entry);
      }
      const item = (advisory: Advisory, dependencies: Dependency[], record?: ResponseRecord): QueueItem => ({ projectId: project.id, advisory, dependencies,
        status: record?.status ?? 'open', note: record?.note ?? '', reviewBy: record?.reviewBy ?? null, updatedAt: record?.updatedAt ?? null, resolvedAt: record?.resolvedAt ?? null,
        priority: priorityOf(advisory.severity, project.exposure, project.lifecycle), priorityReason: priorityReasons[advisory.severity],
        needsReview: !advisory.detailsAvailable || advisory.severity === 'unknown' || !!advisory.severityConflict || !!advisory.severityRetained });
      for (const { advisory, dependencies, variants, retained } of byAdvisory.values()) {
        if (new Set(variants.map(v => v.advisory.fixed)).size > 1) advisory.fixed = null;
        const record = responses.get(`${project.id}\0${advisory.id}`);
        items.push({ ...item(advisory, dependencies, record?.status === 'resolved' ? undefined : record), advisoryVariants: new Set(variants.map(v => JSON.stringify([v.advisory.severity, v.advisory.fixed, v.advisory.detailsAvailable, v.advisory.severityRetained, v.advisory.severityConflict]))).size > 1 ? variants : undefined, retained,
          needsReview: retained || variants.some(v => !v.advisory.detailsAvailable || v.advisory.severityConflict || v.advisory.severityRetained || v.advisory.severity === 'unknown') });
      }
      for (const record of responses.values()) {
        if (record.projectId !== project.id || record.status !== 'resolved' || byAdvisory.has(record.advisoryId)) continue;
        const a = record.advisory;
        items.push(item({ id: a.id, summary: a.summary, severity: a.severity, fixed: a.fixed, aliases: [], severitySource: null, cvss: null, published: null, modified: null, references: [], detailsAvailable: true },
          [{ ecosystem: a.ecosystem ?? 'npm', name: a.package, version: a.version, requested: null, direct: false, scope: 'unknown', source: 'unknown', file: '', component: '' }], record));
      }
    }
    return { items, projects };
  };
  // Each advisory is sent once; items refer to it by id. Thousands of items share a few hundred advisories.
  // ?project= limits it to one project, for the fix memo on the detail page.
  app.get('/api/queue', c => {
    const { items, projects } = responseQueue(c.req.query('project') || undefined);
    const advisories: Record<string, Advisory> = {};
    const compact = items.map(({ advisory, ...item }) => { const advisoryKey = `${item.projectId}\0${advisory.id}`; advisories[advisoryKey] = advisory; return { ...item, advisoryId: advisory.id, advisoryKey,
      dependencies: item.dependencies.map(({ source: _, ...d }) => d) }; });
    return c.json({ advisories, items: compact, projects });
  });
  app.post('/api/queue/status', async c => {
    const input = await c.req.json<{ items: { projectId: string; advisoryId: string }[]; status: ResponseStatus; note?: string; reviewBy?: string | null }>();
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 800 || input.items.some(i => typeof i?.projectId !== 'string' || typeof i?.advisoryId !== 'string') ||
      typeof input.status !== 'string' || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) ||
      (input.reviewBy !== undefined && input.reviewBy !== null && typeof input.reviewBy !== 'string')) throw new CatalogError('対象と対応状況を確認してください（1回800件まで）');
    // Only advisories currently found in the project can be set; resolved ones change only by checking again.
    const found = new Map<string, ResponseRecord['advisory']>();
    for (const projectId of new Set(input.items.map(i => i.projectId))) for (const [id, a] of vulnerabilitySnapshots(store.vulnerabilityCheck(store.project(projectId).id))) found.set(`${projectId}\0${id}`, a);
    const targets = input.items.map(i => ({ projectId: i.projectId, advisory: found.get(`${i.projectId}\0${i.advisoryId}`) }));
    if (targets.some(t => !t.advisory)) throw new CatalogError('今の照会結果にない脆弱性が含まれています。再照会の結果を確認してください', 409);
    const updated = store.setResponses(targets as { projectId: string; advisory: ResponseRecord['advisory'] }[], input.status, input.note ?? '', input.reviewBy || null);
    return c.json({ updated });
  });
  // One status for the whole project. ids are the advisories the client saw; they must be exactly the ones found now,
  // so a check that changed them meanwhile is rejected before anything is written. Notes on each advisory stay,
  // except not-applicable, whose shared reason becomes every advisory's note.
  app.post('/api/projects/:id/response', async c => {
    const project = store.project(c.req.param('id'));
    const input = await c.req.json<{ ids: string[]; status: ResponseStatus; note?: string; reviewBy?: string | null }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.some(id => typeof id !== 'string') ||
      typeof input.status !== 'string' || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) ||
      (input.reviewBy !== undefined && input.reviewBy !== null && typeof input.reviewBy !== 'string')) throw new CatalogError('対象と対応状況を確認してください');
    const found = vulnerabilitySnapshots(store.vulnerabilityCheck(project.id));
    const ids = new Set(input.ids);
    if (ids.size !== found.size || [...ids].some(id => !found.has(id))) throw new CatalogError('照会結果が変わりました。最新の脆弱性を確認してから、もう一度設定してください', 409);
    const updated = store.setResponses([...found.values()].map(advisory => ({ projectId: project.id, advisory })), input.status, input.note ?? '', input.reviewBy || null, input.status !== 'not-applicable');
    return c.json({ updated });
  });
  app.post('/api/projects/tags', async c => {
    const input = await c.req.json<{ ids: string[]; tags: string[] }>();
    if (!Array.isArray(input.ids) || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string') || !Array.isArray(input.tags) ||
      input.tags.length > 30 || input.tags.some(t => typeof t !== 'string' || t.length > 80)) throw new CatalogError('対象とタグを確認してください');
    store.addTags(input.ids, input.tags); return c.json({ projects: store.projects() });
  });
  app.post('/api/projects/lifecycle', async c => {
    const input = await c.req.json<{ ids: string[]; lifecycle: Lifecycle; archiveReason?: string }>();
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > bulkLimit || input.ids.some(id => typeof id !== 'string') || typeof input.lifecycle !== 'string' ||
      (input.archiveReason !== undefined && (typeof input.archiveReason !== 'string' || input.archiveReason.length > 2000))) throw new CatalogError('対象と管理状態を確認してください');
    store.setLifecycle(input.ids, input.lifecycle, input.archiveReason); return c.json({ projects: store.projects() });
  });
  app.post('/api/folder-picker', async c => {
    requireDesktop();
    if (picking) throw new CatalogError('Finderのフォルダ選択がすでに開いています', 409);
    const input = await c.req.json<{ defaultPath?: string; purpose?: string }>();
    let defaultPath: string | undefined;
    if (typeof input.defaultPath === 'string' && input.defaultPath.length <= 4096) defaultPath = await canonicalRoot(input.defaultPath).catch(() => undefined);
    picking = true;
    try { return c.json({ path: await pickFolder(defaultPath, input.purpose === 'exclude' ? '探索から除外するフォルダを選択' : undefined) }); }
    catch { throw new CatalogError('Finderのフォルダ選択を開けませんでした。このMacで起動しているか確認してください', 500); }
    finally { picking = false; }
  });
  const role = (value: unknown): AppRole => {
    if (typeof value !== 'string' || !Object.hasOwn(appRoleLabels, value)) throw new CatalogError('エディタかターミナルを指定してください');
    return value as AppRole;
  };
  // Only existing .app bundles are accepted, so open -a never receives an arbitrary file or command.
  const application = async (path: string) => {
    if (!isAbsolute(path) || !path.endsWith('.app')) return null;
    const resolved = await realpath(path).catch(() => null);
    if (!resolved?.endsWith('.app') || !await stat(resolved).then(info => info.isDirectory(), () => false)) return null;
    return { name: basename(resolved, '.app'), path: resolved };
  };
  app.get('/api/apps', c => c.json({ apps: store.apps() }));
  app.post('/api/apps/pick', async c => {
    requireDesktop();
    const input = await c.req.json<{ role: string }>();
    const target = role(input.role);
    if (picking) throw new CatalogError('Finderの選択画面がすでに開いています', 409);
    picking = true;
    let chosen: string | null;
    try { chosen = await pickApp(`${appRoleLabels[target]}として使うアプリを選択`); }
    catch { throw new CatalogError('アプリの選択画面を開けませんでした。このMacで起動しているか確認してください', 500); }
    finally { picking = false; }
    if (!chosen) return c.json({ apps: store.apps(), cancelled: true });
    const found = await application(chosen);
    if (!found) throw new CatalogError('アプリケーション（.app）を選んでください');
    store.setApp(target, found); return c.json({ apps: store.apps() });
  });
  app.post('/api/apps/clear', async c => {
    const input = await c.req.json<{ role: string }>();
    store.setApp(role(input.role), null); return c.json({ apps: store.apps() });
  });
  app.post('/api/projects/:id/open', async c => {
    requireDesktop();
    const input = await c.req.json<{ role: string }>();
    const target = role(input.role);
    const project = store.project(c.req.param('id'));
    const registered = store.apps()[target];
    if (!registered) throw new CatalogError(`${appRoleLabels[target]}が登録されていません。設定で選んでください`);
    const found = await application(registered.path);
    if (!found) throw new CatalogError(`登録した${appRoleLabels[target]}（${registered.name}）が見つかりません。設定で選び直してください`, 404);
    const exists = await stat(project.path).then(info => info.isDirectory(), () => false);
    if (!exists) throw new CatalogError('フォルダが見つかりません。移動・削除されていないか確認してください', 404);
    try { await openApp(found.path, project.path); } catch { throw new CatalogError(`${found.name}で開けませんでした。このMacで起動しているか確認してください`, 500); }
    return c.json({ ok: true });
  });
  app.post('/api/projects/:id/reveal', async c => {
    requireDesktop();
    const project = store.project(c.req.param('id'));
    const exists = await stat(project.path).then(info => info.isDirectory(), () => false);
    if (!exists) throw new CatalogError('フォルダが見つかりません。移動・削除されていないか確認してください', 404);
    try { await openFolder(project.path); } catch { throw new CatalogError('Finderで表示できませんでした。このMacで起動しているか確認してください', 500); }
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/guard', async c => {
    const project = store.project(c.req.param('id'));
    return c.json(await inspectGuard(project.path));
  });
  app.post('/api/projects/:id/guard', async c => {
    const project = store.project(c.req.param('id'));
    if (isExcluded(store.exclusions(), project.path)) throw new CatalogError('除外されたプロジェクトの設定は変更できません', 409);
    const input = await c.req.json<{ revision?: string }>();
    if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw new CatalogError('設定を再確認してください', 409);
    return c.json(await applyGuard(project.path, input.revision));
  });
  app.get('/api/exclusions', c => c.json({ exclusions: store.exclusions() }));
  // One folder from the picker, or several (paths) when registered projects and folders are excluded from the catalog.
  app.post('/api/exclusions', async c => {
    const input = await c.req.json<{ path?: string; paths?: string[] }>();
    const list = input.paths ?? [input.path];
    if (!Array.isArray(list) || !list.length || list.length > 200 || list.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096)) throw new CatalogError('除外するフォルダを指定してください');
    const paths: string[] = [];
    for (const raw of list as string[]) {
      try { paths.push(await canonicalRoot(raw.trim())); }
      catch { throw new CatalogError(list.length > 1 ? `フォルダが見つからないか、読み取れません: ${raw}` : 'フォルダが見つからないか、読み取れません。絶対パスを確認してください'); }
    }
    store.addExclusions(paths);
    return c.json({ exclusions: store.exclusions(), registeredInside: [...store.paths()].filter(project => paths.some(path => within(path, project))).length });
  });
  // Takes the stored path as is, so a folder that no longer exists can still be removed from the list.
  app.post('/api/exclusions/remove', async c => {
    const input = await c.req.json<{ path: string }>();
    if (typeof input.path !== 'string') throw new CatalogError('除外を解除するフォルダを指定してください');
    store.removeExclusion(input.path); return c.json({ exclusions: store.exclusions() });
  });
  const scanOptions = (query: Record<string, string>) => ({
    limit: query.limit === '0' ? 0 : Math.max(1, Math.min(2000, Math.floor(Number(query.limit)) || 30)),
    offset: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(query.offset)) || 0)),
    query: (query.q || '').slice(0, 300),
    filter: (['new', 'registered'].includes(query.filter) ? query.filter : 'all') as 'all' | 'new' | 'registered',
    exclusions: store.exclusions(),
  });
  const findScan = (id: string) => jobs.get(id, { limit: 0, exclusions: store.exclusions() }) ?? store.scan(id);
  const launchScan = (id: string) => {
    const controller = new AbortController(); controllers.set(id, controller);
    const task = jobs.run(id, controller.signal).finally(() => { controllers.delete(id); scanTasks.delete(id); });
    scanTasks.set(id, task); void task.catch(() => {});
  };
  const requireStopped = () => {
    if (scanTasks.size || sweep?.status === 'running') throw new CatalogError('現在の探索が終わるか、一時停止してから実行してください', 409);
  };
  // Scanning every registered folder, one after another. Kept in memory: after a restart the scan in progress is paused
  // as usual, and the folders already scanned keep their results.
  type Sweep = { status: 'running' | 'completed' | 'stopped'; roots: string[]; done: number; scanId: string | null; skipped: string[]; startedAt: string; endedAt: string | null };
  let sweep: Sweep | null = null;
  const runSweep = async (current: Sweep) => {
    for (const root of current.roots) {
      let path: string | null = null;
      try { path = await canonicalRoot(root); } catch { /* missing or unreadable: skipped below */ }
      const exclusions = store.exclusions();
      if (!path || isExcluded(exclusions, path)) { current.skipped.push(root); current.done++; continue; }
      let scan: Scan;
      try { scan = jobs.create(path, exclusions); } catch { break; }
      current.scanId = scan.id; launchScan(scan.id);
      await scanTasks.get(scan.id)?.catch(() => {});
      current.done++;
      // Pausing or cancelling the scan in progress stops the rest too.
      const status = jobs.get(scan.id, { limit: 0 })?.status;
      if (status === 'paused' || status === 'cancelled') break;
    }
    current.status = current.done === current.roots.length ? 'completed' : 'stopped';
    current.endedAt = new Date().toISOString();
  };
  // The latest DB-backed scan of every registered folder, newest first.
  const latestScans = () => (store.db.prepare(`SELECT j.id FROM scan_jobs j JOIN scan_roots r ON r.path = j.root
    WHERE j.started_at = (SELECT MAX(k.started_at) FROM scan_jobs k WHERE k.root = j.root) ORDER BY j.started_at DESC`).all() as { id: string }[]).map(r => r.id);
  app.get('/api/scan-history', c => {
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    const rows = store.db.prepare(`SELECT id, json_extract(payload,'$.root') AS root, json_extract(payload,'$.status') AS status,
      json_extract(payload,'$.startedAt') AS startedAt,
      COALESCE(json_extract(payload,'$.candidateCount'), json_array_length(payload,'$.candidates')) AS candidateCount
      FROM scans ORDER BY rowid DESC LIMIT 20 OFFSET ?`).all(offset);
    const total = (store.db.prepare('SELECT COUNT(*) AS n FROM scans').get() as { n: number }).n;
    return c.json({ items: rows, total });
  });
  app.get('/api/scans', c => c.json({ scans: jobs.list() }));
  const rootSummary = (path: string, createdAt: string) => {
    const latest = store.db.prepare("SELECT id FROM scans WHERE json_extract(payload,'$.root')=? ORDER BY rowid DESC LIMIT 1").get(path) as { id: string } | undefined;
    const scan = latest ? findScan(latest.id) : null;
    const registered = store.paths(); const exclusions = store.exclusions();
    const candidates = scan?.candidates.filter(candidate => !isExcluded(exclusions, candidate.path)) ?? [];
    const counts = scan ? jobs.get(scan.id, { limit: 0, filter: 'new', exclusions }) : null;
    return { path, createdAt, excluded: !!isExcluded(exclusions, path),
      lastScan: scan ? { id: scan.id, status: scan.status, startedAt: scan.startedAt, endedAt: scan.endedAt,
        candidates: scan.candidateCount ?? candidates.length,
        newCandidates: counts?.filteredCount ?? candidates.filter(candidate => !registered.has(candidate.path)).length } : null };
  };
  app.get('/api/scan-roots', c => c.json({ roots: store.scanRoots().map(root => rootSummary(root.path, root.createdAt)) }));
  app.post('/api/scan-roots/remove', async c => {
    const input = await c.req.json<{ path: string }>();
    if (typeof input.path !== 'string') throw new CatalogError('登録を解除する探索フォルダを指定してください');
    store.removeScanRoot(input.path);
    return c.json({ roots: store.scanRoots().map(root => rootSummary(root.path, root.createdAt)) });
  });
  app.post('/api/scans', async c => {
    requireStopped();
    const input = await c.req.json<{ root: string }>();
    if (typeof input.root !== 'string' || input.root.length > 4096) throw new CatalogError('探索するフォルダを指定してください');
    let root: string;
    try { root = await canonicalRoot(input.root.trim()); } catch { throw new CatalogError('フォルダが見つからないか、読み取れません。絶対パスを確認してください'); }
    requireStopped();
    const exclusions = store.exclusions();
    if (isExcluded(exclusions, root)) throw new CatalogError('このフォルダは除外設定に含まれています');
    store.addScanRoot(root);
    const scan = jobs.create(root, exclusions); launchScan(scan.id);
    return c.json({ scan }, 202);
  });
  app.post('/api/scans/sweep', c => {
    requireStopped();
    const exclusions = store.exclusions();
    const roots = store.scanRoots().map(root => root.path).filter(path => !isExcluded(exclusions, path));
    if (!roots.length) throw new CatalogError('探索できるフォルダがありません。先に探索するフォルダを追加してください');
    const current: Sweep = { status: 'running', roots, done: 0, scanId: null, skipped: [], startedAt: new Date().toISOString(), endedAt: null };
    sweep = current; void runSweep(current);
    return c.json({ sweep: current }, 202);
  });
  app.get('/api/scans/sweep', c => c.json({ sweep }));
  // Every registered folder's latest result as one list. Folders never scanned, or last scanned before DB-backed scans, are counted apart.
  app.get('/api/candidates', c => {
    const scanIds = latestScans();
    return c.json({ ...jobs.combined(scanIds, scanOptions(c.req.query())), folders: { total: store.scanRoots().length, scanned: scanIds.length } });
  });
  app.get('/api/candidates/selection', c => {
    const ids = jobs.combinedIds(latestScans(), { ...scanOptions(c.req.query()), limit: 2001 });
    if (ids.length > 2000) throw new CatalogError('一度に選べるのは2000件までです。検索条件を絞るか、ページごとに選んでください');
    return c.json({ ids });
  });
  app.get('/api/scans/:id', c => {
    const scan = jobs.get(c.req.param('id'), scanOptions(c.req.query()));
    if (!scan) throw new CatalogError('探索結果が見つかりません', 404);
    return c.json({ scan });
  });
  app.get('/api/scans/:id/issues', c => {
    const id = c.req.param('id'); const scan = findScan(id);
    if (!scan) throw new CatalogError('探索結果が見つかりません', 404);
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    if (!scan.persistent) { const legacy = store.scan(id)!; return c.json({ issues: legacy.issues.slice(offset, offset + 100), total: legacy.issues.length }); }
    const fatal = store.db.prepare('SELECT error FROM scan_jobs WHERE id=?').get(id) as { error: string | null };
    const extra = fatal.error ? [{ path: scan.root, message: fatal.error }] : [];
    const first = offset === 0 ? extra : [];
    const rows = store.db.prepare('SELECT path, message FROM scan_job_issues WHERE scan_id=? ORDER BY rowid LIMIT ? OFFSET ?')
      .all(id, 100 - first.length, Math.max(0, offset - extra.length));
    return c.json({ issues: [...first, ...rows], total: scan.issueCount ?? 0 });
  });
  app.get('/api/scans/:id/selection', c => {
    const id = c.req.param('id');
    if (!findScan(id)) throw new CatalogError('探索結果が見つかりません', 404);
    const ids = jobs.selectIds(id, { ...scanOptions(c.req.query()), limit: 2001 });
    if (ids.length > 2000) throw new CatalogError('一度に選べるのは2000件までです。検索条件を絞るか、ページごとに選んでください');
    return c.json({ ids });
  });
  app.post('/api/scans/:id/pause', c => {
    const id = c.req.param('id');
    if (!findScan(id)) throw new CatalogError('探索結果が見つかりません', 404);
    controllers.get(id)?.abort('pause'); return c.json({ ok: true });
  });
  app.post('/api/scans/:id/cancel', c => {
    const id = c.req.param('id');
    if (!findScan(id)) throw new CatalogError('探索結果が見つかりません', 404);
    controllers.get(id)?.abort(); return c.json({ ok: true });
  });
  for (const action of ['resume', 'retry'] as const) app.post(`/api/scans/:id/${action}`, c => {
    requireStopped(); const id = c.req.param('id');
    const scan = action === 'resume' ? jobs.resume(id) : jobs.retry(id);
    launchScan(id); return c.json({ scan }, 202);
  });
  app.post('/api/scans/:id/remove', c => {
    const id = c.req.param('id');
    if (controllers.has(id)) throw new CatalogError('一時停止してから探索記録を削除してください', 409);
    jobs.remove(id); return c.json({ ok: true });
  });
  const revalidatePersistent = async (candidate: Candidate, exclusions: string[]) => {
    if (await canonicalRoot(candidate.path) !== candidate.path) throw new Error('場所が変わりました');
    const verification = jobs.create(candidate.path, exclusions);
    try {
      await jobs.run(verification.id);
      const result = jobs.get(verification.id, { limit: 2, exclusions });
      const refreshed = result?.candidates.find(item => item.path === candidate.path);
      if (!result || result.status !== 'completed' || !refreshed || (!candidate.incomplete && refreshed.fingerprint !== candidate.fingerprint)) throw new Error('構成が変わったか読み取れません');
      return refreshed;
    } finally { jobs.remove(verification.id); }
  };
  app.post('/api/imports', async c => {
    const input = await c.req.json<{ id: string; scanId: string; candidateIds: string[] }>();
    if (typeof input.id !== 'string' || !/^[\w-]{1,80}$/.test(input.id) || !Array.isArray(input.candidateIds) ||
      !input.candidateIds.length || input.candidateIds.length > 2000 || input.candidateIds.some(id => typeof id !== 'string')) throw new CatalogError('追加する候補を確認してください');
    const previous = store.previousImport(input.id); if (previous) return c.json(previous);
    requireStopped();
    // Without scanId the candidates come from the combined list of every folder's latest scan.
    const ids = [...new Set(input.candidateIds)];
    const located = input.scanId === undefined ? jobs.locate(latestScans(), ids) : new Map(ids.map(id => [id, input.scanId]));
    const scans = new Map([...new Set(located.values())].map(id => [id, findScan(id)]));
    if ([...scans.values()].some(scan => !scan || scan.status === 'running' || scan.status === 'failed')) throw new CatalogError('完了した探索結果から選んでください');
    const candidates = ids.map(id => { const scanId = located.get(id); return scanId ? jobs.candidate(scanId, id) : undefined; });
    if (!candidates.length || candidates.some(candidate => !candidate)) throw new CatalogError('候補が見つかりません。再探索してください');
    const exclusions = store.exclusions();
    if (candidates.some(candidate => isExcluded(exclusions, candidate!.path))) throw new CatalogError('除外設定に含まれる候補があります。選択を確認してください', 409);
    // Check every candidate so the error can name all of the changed folders at once.
    const changed: string[] = []; const checked: Candidate[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const scan = scans.get(located.get(ids[index])!)!;
      try { const refreshed = scan.persistent ? await revalidatePersistent(candidate!, exclusions) : await revalidateCandidate(scan.root, candidate!, exclusions); checked.push(candidate!.incomplete ? { ...refreshed, incomplete: undefined } : candidate!); }
      catch { changed.push(candidate!.path); }
    }
    if (changed.length) throw new CatalogError(`探索後に構成が変わったか、読み取れない候補が${changed.length}件あります。再探索してください: ${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' ほか' : ''}`, 409);
    const result = store.import(input.id, checked);
    // Newly registered projects get their purpose and dependencies right away, in the background.
    result.projectIds.forEach(id => purposeQueue.add(id));
    enqueueDependencies(result.projectIds);
    return c.json(result, 201);
  });
  return Object.assign(app, { shutdownScans: async () => {
    if (sweep?.status === 'running') sweep.status = 'stopped';
    for (const controller of controllers.values()) controller.abort('pause');
    await Promise.allSettled([...scanTasks.values()]);
  } });
}
