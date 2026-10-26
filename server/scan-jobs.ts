import { absoluteFolder } from './paths.js';
import type { DatabaseSync } from 'node:sqlite';
import { opendir as fsOpendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Candidate, Component, Evidence, Scan, ScanIssue } from '../shared/types.js';
import type { ScanCandidate, ScanFilter, ScanJobState, ScanPageOptions, ScanSelectOptions } from '../shared/scan-jobs.js';
import { CatalogError } from './store.js';
import { excluded, inspect, isExcluded, known, lockNames, memberMatch, skippedChildren, within, wordpressContent, type NodeInfo } from './scanner.js';

// A resumable scan kept in the database instead of memory. Folders wait in a queue, the subfolders found while a folder is
// listed are staged and committed in batches. A large folder interrupted halfway is re-listed, deduplicating saved child
// names rather than assuming the OS returns entries in the same order (or starts over if it changed). Project grouping runs over the stored folder
// results after every folder is read, with the same rules as groupCandidates, and saves its position after every batch too.
// Components and evidence rows of a candidate are stored as separate rows, so neither grouping nor a page holds a whole
// large project in memory; only candidate() puts them back together.

export interface ScanJobsOptions {
  /** Folders and directory entries handled between commits. */
  batchSize?: number;
  /** Called after every commit. Tests use it to pause or fail at a known point. */
  onCheckpoint?: () => void;
  opendir?: typeof fsOpendir;
}

type Phase = 'traverse' | 'group' | 'done';
type JobRow = { id: string; root: string; status: Scan['status']; phase: Phase; exclusions: string; started_at: string;
  ended_at: string | null; visited: number; excluded: number; found: number; pending: number; processed: number; failed: number;
  issues: number; candidates: number; current_path: string; error: string | null; counter_format: number;
  // Grouping position: stage, the last bare repository checked, the last node finished, and the node in progress with its last child.
  g_stage: '' | 'bare' | 'classify' | 'done'; g_after: string; g_len: number; g_path: string; g_node: string | null; g_depth: number;
  g_child: Uint8Array | null; g_comp: number; g_ev: number };
// A folder read but not yet committed. skip names the subfolders not to enter, or 'all'.
type Finished = { path: string; seq: number; failed: boolean; entries: number; excluded: number; content: boolean;
  skip: 'all' | string[]; node: NodeInfo | null; issues: ScanIssue[] };
// Listing checkpoint count and mtime. Saved names, not enumeration positions, identify children already staged.
type Listing = { path: string; listed: number; mtime: number };
type NodeRow = { path: string; len: number; container: number; payload: string };
type Stop = 'pause' | 'cancel' | null;

// Names that a folder's own detection reads. Anything else is only counted, so a folder of a million files needs no name list.
const markers = new Set(['.git', 'wp-includes', 'wp-content', 'themes', 'plugins']);
const relevant = (name: string) => markers.has(name) || known.test(name) || lockNames.test(name) || /\.(csproj|tf|tf\.json)$/.test(name) || name.endsWith('.dist-info');
// skippedChildren returns every name it was given when all subfolders are skipped. This marker shows that it did.
const ALL = '\0all';
const PAGE_ARRAY = 200;
const COMPONENT = 0;
const EVIDENCE = 1;
const unreadable = 'このフォルダを読み取れません。権限や存在を確認してください';

// A commit that failed while a folder was being listed. It stops the scan instead of counting as an unreadable folder.
class StorageFailure extends Error {
  constructor(public original: unknown) { super('storage'); }
}

const subtree = (path: string): [string, string] => {
  const prefix = path.endsWith(sep) ? path : path + sep;
  return [prefix, prefix.slice(0, -1) + String.fromCharCode(sep.charCodeAt(0) + 1)];
};

const partsOf = (root: string, path: string) => { const rel = relative(root, path); return rel ? rel.split(sep) : []; };
/**
 * Sort key of a folder: its depth, then its path components separated by a zero byte. Ordering by it is the order the
 * in-memory scan reaches folders in (breadth first, subfolders by name), however the folders were queued, so components
 * and fingerprints do not depend on which folders were read again. `open` gives the prefix of every folder below.
 */
function keyOf(depth: number, parts: string[], open = false) {
  const head = Buffer.alloc(4); head.writeUInt32BE(depth);
  return Buffer.concat([head, Buffer.from(parts.join('\0')), Buffer.from(open && parts.length ? [0] : [])]);
}
/** The smallest key above every key starting with prefix. */
function upper(prefix: Buffer) {
  const next = Buffer.from(prefix);
  for (let i = next.length - 1; i >= 0; i--) { if (next[i] < 255) { next[i]++; return next.subarray(0, i + 1); } }
  throw new Error('no upper bound');
}
const candidateId = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24);

export class ScanJobs {
  private batch: number;
  private opendir: typeof fsOpendir;
  /** The job run() is working on in this process, and the folder it is reading. */
  private active: string | null = null;
  private current = '';
  constructor(private db: DatabaseSync, private options: ScanJobsOptions = {}) {
    this.batch = Math.max(1, Math.trunc(options.batchSize ?? 500));
    this.opendir = options.opendir ?? fsOpendir;
    db.exec(`
      CREATE TABLE IF NOT EXISTS scan_jobs (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, exclusions TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, visited INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0,
        found INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, issues INTEGER NOT NULL DEFAULT 0, candidates INTEGER NOT NULL DEFAULT 0,
        current_path TEXT NOT NULL DEFAULT '', error TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_job_queue (
        scan_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, content INTEGER NOT NULL DEFAULT 0, UNIQUE(scan_id, path)
      );
      CREATE INDEX IF NOT EXISTS scan_job_queue_state ON scan_job_queue(scan_id, state);
      CREATE INDEX IF NOT EXISTS scan_job_queue_state_path ON scan_job_queue(scan_id, state, path);
      CREATE TABLE IF NOT EXISTS scan_job_staging (
        scan_id TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, UNIQUE(scan_id, parent, name)
      );
      CREATE TABLE IF NOT EXISTS scan_job_nodes (
        scan_id TEXT NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, len INTEGER NOT NULL, git INTEGER NOT NULL,
        bare INTEGER NOT NULL, boundary INTEGER NOT NULL, members INTEGER NOT NULL, container INTEGER NOT NULL DEFAULT 0,
        owned INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, PRIMARY KEY (scan_id, path)
      );
      CREATE INDEX IF NOT EXISTS scan_job_nodes_order ON scan_job_nodes(scan_id, len, path);
      CREATE INDEX IF NOT EXISTS scan_job_nodes_git ON scan_job_nodes(scan_id, git, path);
      CREATE TABLE IF NOT EXISTS scan_job_issues (
        scan_id TEXT NOT NULL, dir TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scan_job_issues_dir ON scan_job_issues(scan_id, dir);
      CREATE TABLE IF NOT EXISTS scan_job_candidates (
        scan_id TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, path TEXT NOT NULL, search TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (scan_id, id)
      );
      CREATE INDEX IF NOT EXISTS scan_job_candidates_ord ON scan_job_candidates(scan_id, ord);
      CREATE TABLE IF NOT EXISTS scan_job_parts (
        scan_id TEXT NOT NULL, cand TEXT NOT NULL, kind INTEGER NOT NULL, ord INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (scan_id, cand, kind, ord)
      ) WITHOUT ROWID;
    `);
    // Columns added after the first version of these tables. A database from that version gains them here.
    const missingCounters = !(db.prepare('PRAGMA table_info(scan_job_queue)').all() as { name: string }[]).some(c => c.name === 'entries');
    const columns: [string, string, string][] = [
      ['scan_jobs', 'counter_format', 'INTEGER NOT NULL DEFAULT 1'],
      ['scan_jobs', 'g_stage', "TEXT NOT NULL DEFAULT ''"], ['scan_jobs', 'g_after', "TEXT NOT NULL DEFAULT ''"],
      ['scan_jobs', 'g_len', 'INTEGER NOT NULL DEFAULT -1'], ['scan_jobs', 'g_path', "TEXT NOT NULL DEFAULT ''"],
      ['scan_jobs', 'g_node', 'TEXT'], ['scan_jobs', 'g_depth', 'INTEGER NOT NULL DEFAULT 0'], ['scan_jobs', 'g_child', 'BLOB'],
      ['scan_jobs', 'g_comp', 'INTEGER NOT NULL DEFAULT 0'], ['scan_jobs', 'g_ev', 'INTEGER NOT NULL DEFAULT 0'],
      // What a read folder added to the job's counts, so reading it again can take that back first.
      ['scan_job_queue', 'entries', 'INTEGER NOT NULL DEFAULT 0'], ['scan_job_queue', 'skipped', 'INTEGER NOT NULL DEFAULT 0'],
      ['scan_job_queue', 'listed', 'INTEGER NOT NULL DEFAULT 0'], ['scan_job_queue', 'mtime', 'REAL'],
      ['scan_job_nodes', 'ord', 'BLOB'],
      // 1 when the components and evidence are in scan_job_parts. Older rows keep them in payload.
      ['scan_job_candidates', 'parts', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [table, column, definition] of columns) {
      const present = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
      if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    if (missingCounters) db.prepare('UPDATE scan_jobs SET counter_format=0 WHERE processed>0').run();
    db.exec('CREATE INDEX IF NOT EXISTS scan_job_nodes_ord ON scan_job_nodes(scan_id, ord)');
    this.backfillOrder();
    // A job that was running when the server stopped waits to be resumed. Nothing restarts it on its own.
    const stuck = db.prepare("SELECT id FROM scan_jobs WHERE status='running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transaction(() => {
        db.prepare("UPDATE scan_jobs SET status='paused', ended_at=?, current_path='' WHERE id=?").run(new Date().toISOString(), id);
        this.saveSummary(id);
      });
    }
    // A failure on a full disk may have saved the status but not the summary that other readers of the scans table see.
    const stale = db.prepare(`SELECT j.id FROM scan_jobs j LEFT JOIN scans s ON s.id = j.id
      WHERE s.id IS NULL OR json_extract(s.payload, '$.status') IS NOT j.status`).all() as { id: string }[];
    for (const { id } of stale) this.saveSummary(id);
  }

  create(root: string, exclusions: string[]): Scan {
    if (typeof root !== 'string' || !absoluteFolder(root)) throw new CatalogError('探索するフォルダを絶対パスで指定してください');
    this.assertIdle();
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare("INSERT INTO scan_jobs(id, root, status, phase, exclusions, started_at, pending, current_path) VALUES(?, ?, 'running', 'traverse', ?, ?, 1, ?)")
        .run(id, root, JSON.stringify([...new Set(exclusions)]), new Date().toISOString(), root);
      this.db.prepare("INSERT INTO scan_job_queue(scan_id, path, state) VALUES(?, ?, 'pending')").run(id, root);
      this.saveSummary(id);
    });
    return this.summary(this.row(id)!);
  }

  /** The scan with one page of candidates; limit 0 gives only the summary and counts. Scans saved before DB-backed scans existed are paged the same way. */
  get(id: string, options: ScanPageOptions = {}): (Scan & ScanJobState) | null {
    const row = this.row(id);
    if (!row) return this.legacyPage(id, options);
    const { limit, offset, query, filter, exclusions } = pageOptions(options);
    const scan = this.summary(row);
    const base = this.candidateWhere(id, { exclusions, filter: 'all', query: '' });
    const filtered = this.candidateWhere(id, { exclusions, filter, query });
    scan.candidateCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM scan_job_candidates c WHERE ${base.sql}`).get(...base.args) as { n: number }).n;
    scan.filteredCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM scan_job_candidates c WHERE ${filtered.sql}`).get(...filtered.args) as { n: number }).n;
    if (limit) {
      const rows = this.db.prepare(`SELECT c.payload, ${registeredColumns} FROM scan_job_candidates c WHERE ${filtered.sql} ORDER BY c.ord LIMIT ? OFFSET ?`)
        .all(...filtered.args, limit, offset) as { payload: string; registered: number; inside: number }[];
      scan.candidates = rows.map(r => pageCandidate(withRegistration(JSON.parse(r.payload), r)));
    }
    scan.issues = this.issues(row, 100);
    return scan;
  }

  /** Latest ten scans as summaries, including ones saved before DB-backed scans. */
  list(): (Scan & ScanJobState)[] {
    // An old scan keeps every candidate in its payload. Only the summary, the counts and the first issues are read out of it.
    const rows = this.db.prepare(`SELECT id, json_remove(payload, '$.candidates', '$.issues') AS head,
      json_array_length(payload, '$.candidates') AS candidateCount, json_array_length(payload, '$.issues') AS issueCount,
      (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(scans.payload, '$.issues') LIMIT 100)) AS issues
      FROM scans ORDER BY rowid DESC LIMIT 10`).all() as { id: string; head: string; candidateCount: number | null; issueCount: number | null; issues: string }[];
    return rows.map(r => {
      const job = this.row(r.id);
      if (job) return this.summary(job);
      const scan = JSON.parse(r.head) as Scan;
      return { ...scan, candidates: [], issues: JSON.parse(r.issues) as ScanIssue[], candidateCount: r.candidateCount ?? 0, issueCount: r.issueCount ?? 0 };
    });
  }

  /** One candidate in full, with every component and evidence row. */
  candidate(scanId: string, id: string): Candidate | undefined {
    if (!this.row(scanId)) {
      const found = this.legacy(scanId)?.candidates.find(c => c.id === id);
      return found && this.registerLegacy([found])[0];
    }
    const row = this.db.prepare(`SELECT c.payload, c.parts, ${registeredColumns} FROM scan_job_candidates c WHERE c.scan_id=? AND c.id=?`).get(scanId, id) as
      { payload: string; parts: number; registered: number; inside: number } | undefined;
    if (!row) return undefined;
    const candidate = JSON.parse(row.payload) as ScanCandidate;
    if (row.parts) {
      const parts = this.db.prepare('SELECT payload FROM scan_job_parts WHERE scan_id=? AND cand=? AND kind=? ORDER BY ord');
      candidate.components = (parts.all(scanId, id, COMPONENT) as { payload: string }[]).map(p => JSON.parse(p.payload) as Component);
      candidate.evidence = (parts.all(scanId, id, EVIDENCE) as { payload: string }[]).map(p => JSON.parse(p.payload) as Evidence);
    }
    delete candidate.componentTotal; delete candidate.evidenceTotal;
    return withRegistration(candidate, row);
  }

  /** Ids of the candidates matching the filters, in page order, for selecting all of them at once. */
  selectIds(scanId: string, options: ScanSelectOptions): string[] {
    const { query, filter, exclusions } = pageOptions(options);
    const limit = Math.min(10_000, Math.max(1, Math.trunc(Number(options.limit) || 2000)));
    if (!this.row(scanId)) return this.legacyFiltered(scanId, { query, filter, exclusions }).slice(0, limit).map(c => c.id);
    const where = this.candidateWhere(scanId, { exclusions, filter, query });
    return (this.db.prepare(`SELECT c.id FROM scan_job_candidates c WHERE ${where.sql} ORDER BY c.ord LIMIT ?`).all(...where.args, limit) as { id: string }[]).map(r => r.id);
  }

  /** Reads until every folder is read, or until signal aborts: reason 'pause' pauses, anything else cancels. Never rejects for scan failures. */
  async run(id: string, signal?: AbortSignal): Promise<void> {
    if (this.active) throw new CatalogError('現在の探索が終わるか、一時停止してから実行してください', 409);
    const job = this.row(id);
    if (!job) throw new CatalogError('探索結果が見つかりません', 404);
    if (job.status !== 'running') throw new CatalogError('この探索は実行中の状態ではありません。再開してください', 409);
    this.active = id; this.current = job.root;
    try {
      if (job.phase === 'traverse') {
        const stopped = await this.traverse(job, signal);
        if (stopped === 'pause') return this.finish(id, 'paused');
        // The folder results changed, so grouping starts over once, then continues from where it is saved.
        this.transaction(() => {
          if (!stopped) this.db.prepare("UPDATE scan_jobs SET phase='group' WHERE id=?").run(id);
          this.clearCandidates(id);
        });
        // A cancelled scan still shows what it found, with the projects it did not finish marked as partly unread.
        const groupedStop = await this.group(job, stopped ? undefined : signal);
        if (groupedStop) return this.finish(id, groupedStop === 'pause' ? 'paused' : 'cancelled');
        if (stopped === 'cancel') return this.finish(id, 'cancelled');
      } else {
        const groupedStop = await this.group(job, signal);
        if (groupedStop) return this.finish(id, groupedStop === 'pause' ? 'paused' : 'cancelled');
      }
      const done = this.row(id)!;
      this.db.prepare("UPDATE scan_jobs SET phase='done' WHERE id=?").run(id);
      this.finish(id, done.issues ? 'partial' : 'completed');
    } catch (error) {
      this.fail(id, error);
    } finally { this.active = null; this.current = ''; }
  }

  /** Continues a paused, failed, or cancelled scan from its saved queue and grouping position. Call run() next. */
  resume(id: string): Scan & ScanJobState {
    const job = this.row(id);
    if (!job) throw new CatalogError('探索結果が見つかりません', 404);
    if (!resumable(job)) throw new CatalogError('再開できる探索ではありません', 409);
    this.assertIdle();
    this.transaction(() => {
      if (job.phase === 'traverse') this.clearCandidates(id);
      this.db.prepare("UPDATE scan_jobs SET status='running', ended_at=NULL, error=NULL WHERE id=?").run(id);
      this.saveSummary(id);
    });
    return this.summary(this.row(id)!);
  }

  /**
   * Reads again the folders that could not be read and the folders with a file that could not be read or parsed, keeping
   * every other folder. What those folders added to the counts is taken back first, so nothing is counted twice.
   * A stopped scan with nothing to read again but a saved error is resumed instead. Call run() next.
   */
  retry(id: string): Scan & ScanJobState {
    const job = this.row(id);
    if (!job) throw new CatalogError('探索結果が見つかりません', 404);
    if (job.status === 'running') throw new CatalogError('実行中の探索は読み直せません。一時停止してから実行してください', 409);
    this.assertIdle();
    if (job.counter_format === 0) throw new CatalogError('この探索にはフォルダごとの件数が保存されていません。件数を二重に数えないため、新しく探索してください', 409);
    const targets = `SELECT path FROM scan_job_queue WHERE scan_id=? AND (state='failed' OR (state='done' AND path IN (SELECT dir FROM scan_job_issues WHERE scan_id=?)))`;
    const sums = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(state='failed'), 0) AS failed, COALESCE(SUM(entries), 0) AS entries,
      COALESCE(SUM(skipped), 0) AS skipped FROM scan_job_queue WHERE scan_id=? AND path IN (${targets})`).get(id, id, id) as
      { n: number; failed: number; entries: number; skipped: number };
    if (!sums.n) {
      if (job.error && resumable(job)) return this.resume(id);
      throw new CatalogError('読み直すフォルダがありません', 409);
    }
    const db = this.db;
    this.transaction(() => {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_job_retry(path TEXT PRIMARY KEY)');
      db.exec('DELETE FROM temp.scan_job_retry');
      db.prepare(`INSERT INTO temp.scan_job_retry(path) ${targets}`).run(id, id);
      const inRetry = 'IN (SELECT path FROM temp.scan_job_retry)';
      const issues = Number(db.prepare(`DELETE FROM scan_job_issues WHERE scan_id=? AND dir ${inRetry}`).run(id).changes);
      const found = Number(db.prepare(`DELETE FROM scan_job_nodes WHERE scan_id=? AND path ${inRetry}`).run(id).changes);
      db.prepare(`DELETE FROM scan_job_staging WHERE scan_id=? AND parent ${inRetry}`).run(id);
      db.prepare(`UPDATE scan_job_queue SET state='pending', entries=0, skipped=0, listed=0, mtime=NULL WHERE scan_id=? AND path ${inRetry}`).run(id);
      db.exec('DELETE FROM temp.scan_job_retry');
      this.clearCandidates(id);
      db.prepare(`UPDATE scan_jobs SET status='running', phase='traverse', ended_at=NULL, error=NULL, failed=failed-?, pending=pending+?,
        processed=processed-?, issues=issues-?, visited=visited-?, excluded=excluded-?, found=found-? WHERE id=?`)
        .run(sums.failed, sums.n, sums.n, issues, sums.entries, sums.skipped, found, id);
      this.saveSummary(id);
    });
    return this.summary(this.row(id)!);
  }

  /** Deletes a stopped scan and its saved queue and results, including scans saved before DB-backed scans. Registered projects are not touched. */
  remove(id: string): void {
    const job = this.row(id);
    if (!job) {
      const saved = typeof id === 'string' ? this.db.prepare(`SELECT json_extract(payload, '$.persistent') AS persistent,
        json_extract(payload, '$.status') AS status FROM scans WHERE id=?`).get(id) as { persistent: number | null; status: string } | undefined : undefined;
      if (!saved) throw new CatalogError('探索結果が見つかりません', 404);
      if (!saved.persistent && saved.status === 'running') throw new CatalogError('実行中の探索は削除できません。一時停止かキャンセルしてください', 409);
      this.db.prepare('DELETE FROM scans WHERE id=?').run(id);
      return;
    }
    if (job.status === 'running' || this.active === id) throw new CatalogError('実行中の探索は削除できません。一時停止かキャンセルしてください', 409);
    this.transaction(() => {
      for (const table of ['scan_job_queue', 'scan_job_staging', 'scan_job_nodes', 'scan_job_issues', 'scan_job_candidates', 'scan_job_parts']) {
        this.db.prepare(`DELETE FROM ${table} WHERE scan_id=?`).run(id);
      }
      this.db.prepare('DELETE FROM scan_jobs WHERE id=?').run(id);
      this.db.prepare('DELETE FROM scans WHERE id=?').run(id);
    });
  }

  // Traversal

  private async traverse(job: JobRow, signal?: AbortSignal): Promise<Stop> {
    const exclusions = JSON.parse(job.exclusions) as string[];
    const rootContent = await this.rootContent(job.root);
    const contentFlag = this.db.prepare('SELECT content FROM scan_job_queue WHERE scan_id=? AND path=?');
    const isContentRoot = (path: string) => path === rootContent || (contentFlag.get(job.id, path) as { content: number } | undefined)?.content === 1;
    const next = this.db.prepare(`SELECT rowid AS seq, path FROM scan_job_queue INDEXED BY scan_job_queue_state
      WHERE scan_id=? AND state='pending' ORDER BY rowid LIMIT ?`);
    const stagedName = this.db.prepare('SELECT 1 FROM scan_job_staging WHERE scan_id=? AND parent=? AND name=?');
    let finished: Finished[] = []; let staged: [string, string, string][] = []; let units = 0;
    const progress: { listing: Listing | null } = { listing: null };
    const stop = (): Stop => signal?.aborted ? (signal.reason === 'pause' ? 'pause' : 'cancel') : null;
    const flush = () => { this.commit(job, finished, staged, progress.listing); finished = []; staged = []; units = 0; };
    const checkpoint = async () => {
      try { if (units >= this.batch) flush(); } catch (error) { throw new StorageFailure(error); }
      await nextTurn(); return stop();
    };
    for (;;) {
      const chunk = next.all(job.id, this.batch) as { seq: number; path: string }[];
      if (!chunk.length) return null;
      for (const item of chunk) {
        const stopped = stop();
        if (stopped) { flush(); return stopped; }
        this.current = item.path;
        const result = await this.readFolder(job, item, exclusions, isContentRoot, (path, name) => { if (!stagedName.get(job.id, item.path, name)) { staged.push([item.path, name, path]); units++; } }, checkpoint, progress);
        // Re-list from the start, deduplicating saved child names. Directory enumeration order is not stable across opens.
        if (typeof result === 'string') { flush(); return result; }
        progress.listing = null;
        finished.push(result); units++;
        if (units >= this.batch) { flush(); await nextTurn(); }
      }
      flush(); await nextTurn();
    }
  }

  private async readFolder(job: JobRow, item: { seq: number; path: string }, exclusions: string[], isContentRoot: (path: string) => boolean,
    stage: (path: string, name: string) => void, checkpoint: () => Promise<Stop>, progress: { listing: Listing | null }): Promise<Finished | 'pause' | 'cancel'> {
    const { path, seq } = item;
    const result: Finished = { path, seq, failed: false, entries: 0, excluded: 0, content: false, skip: 'all', node: null, issues: [] };
    if (isExcluded(exclusions, path)) return { ...result, excluded: 1 };
    const saved = this.db.prepare('SELECT listed, mtime FROM scan_job_queue WHERE scan_id=? AND path=?').get(job.id, path) as { listed: number; mtime: number | null };
    const grandparent = dirname(dirname(path));
    const contentRoots = new Set(isContentRoot(grandparent) ? [grandparent] : []);
    try {
      // Every queued path was a real folder inside the root when listed. A symlink or move since then is not followed.
      if (await realpath(path) !== path || !within(job.root, path)) throw new Error('moved');
      const { mtimeMs: mtime } = await stat(path);
      // An interrupted read keeps child names in staging. Re-list every entry, even if mtime is unchanged: the OS may
      // enumerate the same directory in another order. If mtime changed, discard old provisional names first.
      const resumeAt = saved.listed > 0 && saved.mtime === mtime ? saved.listed : 0;
      if (!resumeAt) {
        try {
          this.transaction(() => {
            this.db.prepare('DELETE FROM scan_job_staging WHERE scan_id=? AND parent=?').run(job.id, path);
            this.db.prepare('UPDATE scan_job_queue SET listed=0, mtime=NULL WHERE scan_id=? AND path=?').run(job.id, path);
          });
        } catch (error) { throw new StorageFailure(error); }
      }
      const names = new Set<string>();
      let entries = 0; let skipped = 0; let distInfo = false;
      for await (const entry of await this.opendir(path, { bufferSize: 128 })) {
        entries++;
        const link = entry.isSymbolicLink();
        // One .dist-info name is enough to tell a pip install target.
        if (!link && relevant(entry.name) && !(distInfo && entry.name.endsWith('.dist-info'))) {
          names.add(entry.name); distInfo ||= entry.name.endsWith('.dist-info');
        }
        if (link || excluded.has(entry.name) || (entry.isDirectory() && isExcluded(exclusions, join(path, entry.name)))) skipped++;
        else if (entry.isDirectory()) stage(join(path, entry.name), entry.name);
        if (entries % this.batch === 0) {
          progress.listing = { path, listed: Math.max(entries, resumeAt), mtime };
          const stopped = await checkpoint(); if (stopped) return stopped;
        }
      }
      if (await realpath(path) !== path) throw new Error('moved');
      const content = await wordpressContent(path, names);
      const rule = skippedChildren(path, new Set([...names, ALL]), content, contentRoots);
      const all = rule.has(ALL);
      const issues: ScanIssue[] = [];
      const node = await inspect(job.root, path, names, { issues } as unknown as Scan, all ? new Set([ALL]) : rule, content);
      return { ...result, entries, excluded: skipped, content, skip: all ? 'all' : [...rule], node, issues };
    } catch (error) {
      if (error instanceof StorageFailure) throw error.original;
      return { ...result, failed: true, issues: [{ path, message: unreadable }] };
    }
  }

  /**
   * Commits finished folders together with the subfolders they staged, and how far the folder being read is listed.
   * A folder already committed is ignored, so a redo cannot count twice. Each folder's own counts are kept with it for retry().
   */
  private commit(job: JobRow, finished: Finished[], staged: [string, string, string][], listing: Listing | null) {
    if (!finished.length && !staged.length) return;
    const db = this.db; const id = job.id;
    const d = { visited: 0, excluded: 0, found: 0, pending: 0, processed: 0, failed: 0, issues: 0 };
    this.transaction(() => {
      const stage = db.prepare('INSERT OR IGNORE INTO scan_job_staging(scan_id, parent, name, path) VALUES(?, ?, ?, ?)');
      for (const [parent, name, path] of staged) stage.run(id, parent, name, path);
      if (listing) db.prepare("UPDATE scan_job_queue SET listed=?, mtime=? WHERE scan_id=? AND path=? AND state='pending'").run(listing.listed, listing.mtime, id, listing.path);
      const mark = db.prepare("UPDATE scan_job_queue SET state=?, content=?, entries=?, skipped=?, listed=0, mtime=NULL WHERE scan_id=? AND path=? AND state='pending'");
      const count = db.prepare('SELECT COUNT(*) AS n FROM scan_job_staging WHERE scan_id=? AND parent=? AND (? OR name IN (SELECT value FROM json_each(?)))');
      // Subfolders enter the queue in name order, the order readdir gives the in-memory scan, so components and fingerprints match it.
      const enqueue = db.prepare(`INSERT OR IGNORE INTO scan_job_queue(scan_id, path, state) SELECT scan_id, path, 'pending' FROM scan_job_staging
        WHERE scan_id=? AND parent=? AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY name`);
      const drop = db.prepare('DELETE FROM scan_job_nodes WHERE scan_id=? AND path=?');
      const node = db.prepare('INSERT INTO scan_job_nodes(scan_id, path, seq, len, git, bare, boundary, members, payload, ord) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const issue = db.prepare('INSERT INTO scan_job_issues(scan_id, dir, kind, path, message) VALUES(?, ?, ?, ?, ?)');
      const unstage = db.prepare('DELETE FROM scan_job_staging WHERE scan_id=? AND parent=?');
      for (const f of finished) {
        const names = JSON.stringify(f.skip === 'all' ? [] : f.skip);
        const skipped = f.failed ? 0 : f.excluded + (count.get(id, f.path, f.skip === 'all' ? 1 : 0, names) as { n: number }).n;
        const entries = f.failed ? 0 : f.entries;
        if (mark.run(f.failed ? 'failed' : 'done', f.content ? 1 : 0, entries, skipped, id, f.path).changes !== 1) continue;
        d.processed++; d.pending--;
        if (f.failed) d.failed++;
        else {
          d.excluded += skipped;
          if (f.skip !== 'all') d.pending += Number(enqueue.run(id, f.path, names).changes);
          d.visited += entries;
          if (f.node) {
            const n = f.node;
            // A folder read again replaces what an earlier read stored.
            d.found -= Number(drop.run(id, n.path).changes);
            node.run(id, n.path, f.seq, n.path.length, n.git ? 1 : 0, n.git && n.evidence.length === 1 ? 1 : 0, n.boundary ? 1 : 0,
              n.members.length ? 1 : 0, JSON.stringify(n), keyOf(partsOf(job.root, n.path).length, partsOf(job.root, n.path)));
            d.found++;
          }
        }
        unstage.run(id, f.path);
        for (const i of f.issues) { issue.run(id, f.path, f.failed ? 'read' : 'file', i.path, i.message); d.issues++; }
      }
      db.prepare(`UPDATE scan_jobs SET visited=visited+?, excluded=excluded+?, found=found+?, pending=pending+?, processed=processed+?,
        failed=failed+?, issues=issues+?, current_path=? WHERE id=?`)
        .run(d.visited, d.excluded, d.found, d.pending, d.processed, d.failed, d.issues, this.current, id);
      this.saveSummary(id);
    });
    this.options.onCheckpoint?.();
  }

  // A scan rooted at a plugin or theme skips its internals as a scan of the whole site does (see runScan).
  private async rootContent(root: string) {
    const grandparent = dirname(dirname(root));
    if (!['plugins', 'themes', 'mu-plugins'].includes(basename(dirname(root)))) return null;
    const names = new Set<string>();
    try { for await (const entry of await this.opendir(grandparent)) if (entry.name === 'themes' || entry.name === 'plugins') names.add(entry.name); } catch { /* unreadable: not a site */ }
    return await wordpressContent(grandparent, names) ? grandparent : null;
  }

  // Grouping. Same rules as groupCandidates, over the stored folder results: ancestors are point lookups and descendants are
  // index ranges. Every commit saves the position, so a pause or a restart continues from the last commit: the bare repository
  // check by path, the classification by (length, path), and a project with many folders inside after its last saved folder.

  private async group(job: JobRow, signal?: AbortSignal): Promise<Stop> {
    const db = this.db; const id = job.id; const root = job.root;
    const stopped = (): Stop => signal?.aborted ? (signal.reason === 'pause' ? 'pause' : 'cancel') : null;
    const paused = () => stopped() !== null;
    if (!this.row(id)!.g_stage) {
      this.transaction(() => {
        this.clearCandidates(id);
        db.prepare('UPDATE scan_job_nodes SET owned=0, container=0 WHERE scan_id=?').run(id);
        db.prepare("UPDATE scan_jobs SET g_stage='bare' WHERE id=?").run(id);
      });
    }
    // A repository with nothing but .git at its root that holds other detected folders is a container, not a candidate.
    if (this.row(id)!.g_stage === 'bare') {
      const bare = db.prepare('SELECT path FROM scan_job_nodes WHERE scan_id=? AND git=1 AND bare=1 AND path > ? ORDER BY path LIMIT ?');
      const anyInside = db.prepare('SELECT 1 FROM scan_job_nodes WHERE scan_id=? AND path > ? AND path < ? LIMIT 1');
      const setContainer = db.prepare('UPDATE scan_job_nodes SET container=1 WHERE scan_id=? AND path=?');
      for (let after = this.row(id)!.g_after; ;) {
        const page = bare.all(id, after, this.batch) as { path: string }[];
        if (!page.length) {
          this.transaction(() => db.prepare("UPDATE scan_jobs SET g_stage='classify', g_len=-1, g_path='', g_node=NULL, g_child=NULL WHERE id=?").run(id));
          break;
        }
        after = page[page.length - 1].path;
        this.transaction(() => {
          for (const { path } of page) if (anyInside.get(id, ...subtree(path))) setContainer.run(id, path);
          db.prepare('UPDATE scan_jobs SET g_after=? WHERE id=?').run(after, id);
        });
        this.options.onCheckpoint?.();
        await nextTurn();
        if (paused()) return stopped();
      }
    }
    const saved = this.row(id)!;
    if (saved.g_stage !== 'classify') return null;

    const nodes = db.prepare('SELECT path, len, container, payload FROM scan_job_nodes WHERE scan_id=? AND (len, path) > (?, ?) ORDER BY len, path LIMIT ?');
    const owned = db.prepare('SELECT owned FROM scan_job_nodes WHERE scan_id=? AND path=?');
    const point = db.prepare('SELECT git, container FROM scan_job_nodes WHERE scan_id=? AND path=?');
    const below = db.prepare('SELECT path, git, payload, ord FROM scan_job_nodes WHERE scan_id=? AND ord > ? AND ord < ? ORDER BY ord LIMIT ?');
    const own = db.prepare('UPDATE scan_job_nodes SET owned=1 WHERE scan_id=? AND path=?');
    const unfinished = db.prepare("SELECT 1 FROM scan_job_queue WHERE scan_id=? AND state IN ('pending', 'failed') AND path > ? AND path < ? LIMIT 1");
    const insert = db.prepare('INSERT INTO scan_job_candidates(scan_id, id, ord, path, search, payload, parts) VALUES(?, ?, ?, ?, ?, ?, 1)');
    const part = db.prepare('INSERT INTO scan_job_parts(scan_id, cand, kind, ord, payload) VALUES(?, ?, ?, ?, ?)');
    const preview = db.prepare('SELECT payload FROM scan_job_parts WHERE scan_id=? AND cand=? AND kind=? ORDER BY ord LIMIT ?');
    const save = db.prepare('UPDATE scan_jobs SET g_len=?, g_path=?, g_node=?, g_depth=?, g_child=?, g_comp=?, g_ev=?, candidates=? WHERE id=?');
    const isGit = (path: string) => (point.get(id, path) as { git: number } | undefined)?.git === 1;
    const top = db.prepare('SELECT ord FROM scan_job_nodes WHERE scan_id=? ORDER BY ord DESC LIMIT 1').get(id) as { ord: Uint8Array } | undefined;
    const maxDepth = top ? Buffer.from(top.ord).readUInt32BE(0) : 0;

    // s.len / s.path: the last node finished. s.node: a node with many folders inside that was saved partway, with the last folder below it handled.
    const s = { len: saved.g_len, path: saved.g_path, node: saved.g_node, depth: saved.g_depth,
      child: saved.g_child ? Buffer.from(saved.g_child) : null, comp: saved.g_comp, ev: saved.g_ev, count: saved.candidates };
    let units = 0;
    const begin = () => { if (!db.isTransaction) db.exec('BEGIN IMMEDIATE'); };
    // Commits with the position, then lets other work run. True when asked to pause.
    const flush = async () => {
      begin();
      save.run(s.len, s.path, s.node, s.depth, s.child, s.comp, s.ev, s.count, id);
      this.saveSummary(id);
      db.exec('COMMIT');
      units = 0;
      this.options.onCheckpoint?.();
      await nextTurn();
      return paused();
    };

    // Groups one node. Children before the saved position were written by an earlier run and are only read again for the fingerprint and technologies.
    const groupNode = async (row: NodeRow): Promise<boolean> => {
      const node = JSON.parse(row.payload) as NodeInfo;
      const cand = candidateId(node.path);
      const resuming = s.node === node.path;
      // Record the enclosing container repository, since the candidate itself has no .git.
      const enclosing: Evidence[] = [];
      if (!node.git) {
        for (let p = dirname(node.path); within(root, p); p = dirname(p)) {
          const found = point.get(id, p) as { git: number; container: number } | undefined;
          if (found?.git) {
            if (found.container) enclosing.push({ file: join(relative(node.path, p), '.git'),
              detail: `Gitリポジトリ「${basename(p)}」の中にあります。リポジトリ直下に設定ファイルがないため、中のアプリを個別の候補にしています` });
            break;
          }
          if (p === dirname(p)) break;
        }
      }
      const hash = createHash('sha256').update(node.fingerprint);
      const technologies = new Set(node.technologies);
      if (!resuming) {
        begin();
        db.prepare('DELETE FROM scan_job_parts WHERE scan_id=? AND cand=?').run(id, cand);
        Object.assign(s, { node: node.path, depth: 0, child: null, comp: 0, ev: 0 });
        for (const e of [...node.evidence, ...enclosing]) part.run(id, cand, EVIDENCE, s.ev++, JSON.stringify(e));
      }
      if (node.boundary || node.members.length) {
        const member = (path: string) => node.members.some(p => !p.startsWith('!') && memberMatch(p, path)) &&
          !node.members.some(p => p.startsWith('!') && memberMatch(p.slice(1), path));
        const parts = partsOf(root, node.path);
        // Folders below, depth by depth and by name within a depth: the order of the in-memory scan.
        for (let depth = parts.length + 1; depth <= maxDepth; depth++) {
          const lo = keyOf(depth, parts, true); const hi = upper(lo);
          for (let after = lo; ;) {
            const page = below.all(id, after, hi, this.batch) as { path: string; git: number; payload: string; ord: Uint8Array }[];
            if (!page.length) break;
            for (const child of page) {
              after = Buffer.from(child.ord);
              const replay = resuming && s.child !== null && (depth < s.depth || (depth === s.depth && Buffer.compare(after, s.child) <= 0));
              let keep = !child.git && (node.boundary || member(relative(node.path, child.path).split(sep).join('/')));
              // Folders inside a nested Git repository belong to that repository.
              if (keep) for (let p = dirname(child.path); p !== node.path && within(node.path, p); p = dirname(p)) if (isGit(p)) { keep = false; break; }
              if (keep) {
                const info = JSON.parse(child.payload) as NodeInfo;
                hash.update('\n' + info.fingerprint);
                for (const t of info.technologies) technologies.add(t);
                if (!replay) {
                  begin();
                  own.run(id, child.path);
                  const at = relative(node.path, child.path);
                  part.run(id, cand, COMPONENT, s.comp++, JSON.stringify({ name: info.name, path: at, technologies: info.technologies } satisfies Component));
                  for (const e of info.evidence) part.run(id, cand, EVIDENCE, s.ev++, JSON.stringify({ ...e, file: join(at, e.file) }));
                }
              }
              if (!replay) { s.depth = depth; s.child = after; units++; }
            }
            if (units >= this.batch) { if (await flush()) return true; }
            else if (!db.isTransaction) await nextTurn();
          }
        }
      }
      begin();
      const rows = (kind: number) => (preview.all(id, cand, kind, PAGE_ARRAY) as { payload: string }[]).map(r => JSON.parse(r.payload));
      const candidate: ScanCandidate = { id: cand, path: node.path, name: node.name, technologies: [...technologies],
        components: rows(COMPONENT) as Component[], evidence: rows(EVIDENCE) as Evidence[], fingerprint: hash.digest('hex'), registered: false };
      if (s.comp > PAGE_ARRAY) candidate.componentTotal = s.comp;
      if (s.ev > PAGE_ARRAY) candidate.evidenceTotal = s.ev;
      // Folders left unread inside, by a stop or a read failure, make the candidate only partly known.
      if (unfinished.get(id, ...subtree(node.path))) candidate.incomplete = true;
      insert.run(id, cand, s.count++, candidate.path, [candidate.name, candidate.path, ...candidate.technologies].join('\n'), JSON.stringify(candidate));
      Object.assign(s, { node: null, depth: 0, child: null, comp: 0, ev: 0 });
      return false;
    };

    for (;;) {
      const page = nodes.all(id, s.len, s.path, this.batch) as NodeRow[];
      if (!page.length) break;
      for (const row of page) {
        if (!row.container && !(owned.get(id, row.path) as { owned: number }).owned && await groupNode(row)) return stopped();
        s.len = row.len; s.path = row.path; units++;
        if (units >= this.batch && await flush()) return stopped();
      }
    }
    begin();
    db.prepare("UPDATE scan_jobs SET g_stage='done' WHERE id=?").run(id);
    await flush();
    return null;
  }

  // Storage helpers

  private row(id: string) {
    if (typeof id !== 'string') return undefined;
    return this.db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(id) as JobRow | undefined;
  }

  private assertIdle() {
    if (this.active || this.db.prepare("SELECT 1 FROM scan_jobs WHERE status='running' LIMIT 1").get()) {
      throw new CatalogError('現在の探索が終わるか、一時停止してから実行してください', 409);
    }
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Drops the grouping result and position, so the next grouping starts over. */
  private clearCandidates(id: string) {
    this.db.prepare('DELETE FROM scan_job_candidates WHERE scan_id=?').run(id);
    this.db.prepare('DELETE FROM scan_job_parts WHERE scan_id=?').run(id);
    this.db.prepare(`UPDATE scan_jobs SET candidates=0, g_stage='', g_after='', g_len=-1, g_path='', g_node=NULL, g_depth=0, g_child=NULL,
      g_comp=0, g_ev=0 WHERE id=?`).run(id);
  }

  /** Nodes stored before the sort key existed get it from their path. */
  private backfillOrder() {
    const missing = this.db.prepare(`SELECT n.rowid AS rid, n.path, j.root FROM scan_job_nodes n LEFT JOIN scan_jobs j ON j.id = n.scan_id
      WHERE n.ord IS NULL LIMIT 1000`);
    for (;;) {
      const rows = missing.all() as { rid: number; path: string; root: string | null }[];
      if (!rows.length) return;
      this.transaction(() => {
        for (const r of rows) {
          if (r.root === null) this.db.prepare('DELETE FROM scan_job_nodes WHERE rowid=?').run(r.rid);
          else this.db.prepare('UPDATE scan_job_nodes SET ord=? WHERE rowid=?').run(keyOf(partsOf(r.root, r.path).length, partsOf(r.root, r.path)), r.rid);
        }
      });
    }
  }

  private finish(id: string, status: Scan['status']) {
    this.transaction(() => {
      this.db.prepare("UPDATE scan_jobs SET status=?, ended_at=?, current_path='' WHERE id=?").run(status, new Date().toISOString(), id);
      this.saveSummary(id);
    });
  }

  // Whatever was committed stays: the queue and the grouping position are saved, so the scan can be resumed.
  private fail(id: string, error: unknown) {
    const full = /SQLITE_FULL|full/i.test(String((error as { message?: string })?.message ?? ''));
    const message = full ? '保存先の空き容量が足りず、探索を続けられませんでした。空きを確保してから再開してください'
      : '探索に失敗しました。読み取れた所までは保存されています。再開してください';
    try {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.transaction(() => {
        this.db.prepare("UPDATE scan_jobs SET status='failed', ended_at=?, error=?, current_path='' WHERE id=?").run(new Date().toISOString(), message, id);
        this.saveSummary(id);
      });
    } catch {
      // A full disk may still allow rewriting the status in place, so the job does not block new scans until a restart.
      try { this.db.prepare("UPDATE scan_jobs SET status='failed' WHERE id=?").run(id); }
      catch { /* The database is unavailable. The job stays running in storage and is paused on the next start. */ }
    }
  }

  private summary(row: JobRow): Scan & ScanJobState {
    const running = row.status === 'running' && this.active === row.id;
    const canResume = resumable(row);
    return { id: row.id, root: row.root, status: row.status, startedAt: row.started_at, endedAt: row.ended_at, visited: row.visited,
      excluded: row.excluded, candidates: [], issues: [], currentPath: running ? this.current : row.current_path,
      exclusions: (JSON.parse(row.exclusions) as string[]).filter(path => within(row.root, path)), found: row.found, pending: row.pending,
      persistent: true, candidateCount: row.candidates, processedFolders: row.processed, errorCount: row.failed, issueCount: row.issues + (row.error ? 1 : 0),
      phase: row.phase, canResume, canRetry: row.counter_format !== 0 && row.status !== 'running' && (row.failed > 0 || row.issues > 0 || (!!row.error && canResume)) };
  }

  /** The scans table keeps only the summary of a DB-backed scan, so existing readers of that table stay small. */
  private saveSummary(id: string) {
    const row = this.row(id);
    if (row) this.db.prepare('INSERT INTO scans(id, payload) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(this.summary(row)));
  }

  private issues(row: JobRow, limit: number): ScanIssue[] {
    const fatal = row.error ? [{ path: row.root, message: row.error }] : [];
    return [...fatal, ...this.db.prepare('SELECT path, message FROM scan_job_issues WHERE scan_id=? ORDER BY rowid LIMIT ?').all(row.id, limit - fatal.length) as { path: string; message: string }[]];
  }

  private candidateWhere(id: string, { exclusions, filter, query }: { exclusions: string[]; filter: ScanFilter; query: string }) {
    let sql = `c.scan_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE c.path = e.value OR (c.path > e.value || '/' AND c.path < e.value || '0'))`;
    const args: (string | number)[] = [id, JSON.stringify(exclusions)];
    if (query) { sql += ' AND instr(lower(c.search), lower(?)) > 0'; args.push(query); }
    if (filter !== 'all') sql += ` AND ${filter === 'new' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM projects p WHERE p.path = c.path)`;
    return { sql, args };
  }

  // Scans saved in full before DB-backed scans existed.

  private legacy(id: string): Scan | null {
    if (typeof id !== 'string') return null;
    const row = this.db.prepare('SELECT payload FROM scans WHERE id=?').get(id) as { payload: string } | undefined;
    const scan = row ? JSON.parse(row.payload) as Scan : null;
    return scan && !scan.persistent ? scan : null;
  }

  private registerLegacy(candidates: Candidate[]): Candidate[] {
    const paths = (this.db.prepare('SELECT path FROM projects').all() as { path: string }[]).map(r => r.path);
    const registered = new Set(paths);
    return candidates.map(c => ({ ...c, registered: registered.has(c.path), registeredInside: paths.filter(p => p.startsWith(c.path + sep)).length }));
  }

  private legacyFiltered(id: string, { query, filter, exclusions }: { query: string; filter: ScanFilter; exclusions: string[] }) {
    const scan = this.legacy(id);
    if (!scan) return [];
    const q = query.toLowerCase();
    return this.registerLegacy(scan.candidates.filter(c => !isExcluded(exclusions, c.path)))
      .filter(c => !q || [c.name, c.path, ...c.technologies].join('\n').toLowerCase().includes(q))
      .filter(c => filter === 'all' || (filter === 'new') !== c.registered);
  }

  private legacyPage(id: string, options: ScanPageOptions): Scan | null {
    const scan = this.legacy(id);
    if (!scan) return null;
    const { limit, offset, query, filter, exclusions } = pageOptions(options);
    const filtered = this.legacyFiltered(id, { query, filter, exclusions });
    return { ...scan, candidates: filtered.slice(offset, offset + limit).map(pageCandidate), issues: scan.issues.slice(0, 100),
      candidateCount: scan.candidates.filter(c => !isExcluded(exclusions, c.path)).length, filteredCount: filtered.length, issueCount: scan.issues.length };
  }
}

/** Paused, failed or cancelled: the saved queue and grouping position let run() continue. */
const resumable = (row: JobRow) => ['paused', 'failed', 'cancelled'].includes(row.status);

const registeredColumns = `EXISTS (SELECT 1 FROM projects p WHERE p.path = c.path) AS registered,
  (SELECT COUNT(*) FROM projects p WHERE p.path > c.path || '/' AND p.path < c.path || '0') AS inside`;

function withRegistration<T extends Candidate>(candidate: T, row: { registered: number; inside: number }): T {
  return { ...candidate, registered: row.registered === 1, registeredInside: row.inside };
}

// A page lists the first rows of a very large project and says how many there are; candidate() has all of them.
// Candidates grouped by this version are stored that way already; older rows and old scans are cut here.
function pageCandidate(candidate: ScanCandidate): ScanCandidate {
  const page: ScanCandidate = { ...candidate };
  if (candidate.components.length > PAGE_ARRAY) { page.components = candidate.components.slice(0, PAGE_ARRAY); page.componentTotal = candidate.components.length; }
  if (candidate.evidence.length > PAGE_ARRAY) { page.evidence = candidate.evidence.slice(0, PAGE_ARRAY); page.evidenceTotal = candidate.evidence.length; }
  return page;
}

function pageOptions(options: ScanPageOptions) {
  const requested = Number(options.limit);
  const limit = options.limit !== undefined && requested === 0 ? 0 : Math.min(2000, Math.max(1, Math.trunc(requested) || 2000));
  const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
  const query = typeof options.query === 'string' ? options.query.trim().slice(0, 200) : '';
  const filter: ScanFilter = options.filter === 'new' || options.filter === 'registered' ? options.filter : 'all';
  const exclusions = Array.isArray(options.exclusions) ? options.exclusions.filter((p): p is string => typeof p === 'string') : [];
  return { limit, offset, query, filter, exclusions };
}
