import type { Advisory, Dependency, Ecosystem, Severity } from '../shared/types.js';
import { compareSemver, compareVersions } from '../shared/semver.js';
import { normalizePython } from './python-locks.js';
import { scoreSeverityEntry } from './cvss.js';
export { compareSemver };

// Queries OSV (https://osv.dev) for known vulnerabilities of exact package versions: npm, Packagist (Composer), and PyPI.
// Only the ecosystem, package name, and version leave this Mac: never paths, project names, or source.
export const osvEndpoint = 'https://api.osv.dev';
const batchSize = 500;
const detailConcurrency = 8;

export interface OsvQuery { ecosystem: Ecosystem; name: string; version: string }
export interface OsvSeverity { type?: string; score?: string; source?: string }
export interface OsvAffected {
  package?: { ecosystem?: string; name?: string }; ranges?: { type?: string; events?: Record<string, string | undefined>[] }[]; versions?: string[];
  /** Severity for this package only (https://ossf.github.io/osv-schema/#affectedseverity-field). The top-level severity is then absent. */
  severity?: OsvSeverity[];
  ecosystem_specific?: { severity?: string };
  database_specific?: { severity?: string };
}
/** The declared shape. Records come from the network as JSON, so readers below check every field before use. */
export interface OsvRecord {
  id: string; summary?: string; details?: string; aliases?: string[]; modified?: string; published?: string; withdrawn?: string;
  affected?: OsvAffected[];
  severity?: OsvSeverity[];
  database_specific?: { severity?: string };
  references?: { type?: string; url?: string }[];
}
/** The two OSV calls used. Replaced in tests so they never reach the network. */
export interface OsvClient {
  queryBatch(queries: (OsvQuery & { pageToken?: string })[]): Promise<{ ids: string[]; nextPageToken?: string }[]>;
  vulnerability(id: string): Promise<OsvRecord>;
}

/** status is null when the request never got an answer (network error or timeout). retryAfter is in milliseconds. */
export class OsvError extends Error {
  constructor(message: string, public status: number | null, public retryAfter?: number) { super(message); }
}
// Busy (429), server errors, and requests without an answer are worth retrying. A 4xx answer will not change.
const retryable = (error: unknown) => error instanceof OsvError && (error.status === null || error.status === 429 || error.status >= 500);

async function request(url: string, init: RequestInit) {
  let response: Response;
  try { response = await fetch(url, init); } catch (error) { throw new OsvError(`OSV did not answer: ${(error as Error).message}`, null); }
  if (!response.ok) {
    const seconds = Number(response.headers.get('retry-after'));
    throw new OsvError(`OSV responded ${response.status}`, response.status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  return response.json() as Promise<any>;
}

export const osvApi: OsvClient = {
  async queryBatch(queries) {
    const body = { queries: queries.map(q => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.version, ...(q.pageToken ? { page_token: q.pageToken } : {}) })) };
    const data = await request(`${osvEndpoint}/v1/querybatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!Array.isArray(data.results) || data.results.length !== queries.length) throw new Error('OSV returned an unexpected number of results');
    return data.results.map((result: any) => ({ ids: Array.isArray(result?.vulns) ? result.vulns.map((v: any) => String(v.id)) : [], nextPageToken: result?.next_page_token || undefined }));
  },
  async vulnerability(id) {
    return request(`${osvEndpoint}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
  },
};

/** Sources whose packages may be sent: the public registry, other registries such as mirrors, and the configured registry when unrecorded. */
export const sendableSources = new Set<Dependency['source']>(['registry', 'other-registry', 'registry-unrecorded']);

export interface QueryOutcome { ids: Map<string, string[]>; failed: Set<string> }

export interface RunOptions {
  /** Retries after the first attempt. Waits double each time (1s, 2s, 4s...), or follow Retry-After, up to 60s. */
  retries?: number;
  wait?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, { retries = 4, wait = sleep }: RunOptions) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= retries || !retryable(error)) throw error;
      await wait(Math.min((error as OsvError).retryAfter ?? 1000 * 2 ** attempt, 60_000));
    }
  }
}
// npm keys stay "name@version" as before, so earlier fixtures still answer. Other ecosystems are prefixed, since names may collide.
export const queryKey = (ecosystem: Ecosystem, name: string, version: string) => ecosystem === 'npm' ? `${name}@${version}` : `${ecosystem}:${name}@${version}`;

/**
 * Queries every package version once, following each query's pages to the end before counting it as answered.
 * A failed batch marks its package versions as failed instead of empty.
 */
export async function queryAll(client: OsvClient, queries: OsvQuery[], options: RunOptions = {}): Promise<QueryOutcome> {
  const ids = new Map<string, string[]>(); const failed = new Set<string>();
  // Batches go one after another, so a large check never floods the service.
  for (let start = 0; start < queries.length; start += batchSize) {
    options.onProgress?.(start, queries.length);
    let pending = queries.slice(start, start + batchSize).map(q => ({ ...q, pageToken: undefined as string | undefined }));
    try {
      while (pending.length) {
        const batch = pending;
        const results = await withRetry(() => client.queryBatch(batch), options);
        const next: typeof pending = [];
        results.forEach((result, i) => {
          const key = queryKey(pending[i].ecosystem, pending[i].name, pending[i].version);
          ids.set(key, [...(ids.get(key) || []), ...result.ids]);
          if (result.nextPageToken) next.push({ ...pending[i], pageToken: result.nextPageToken });
        });
        pending = next;
      }
    } catch {
      for (const q of queries.slice(start, start + batchSize)) { const key = queryKey(q.ecosystem, q.name, q.version); failed.add(key); ids.delete(key); }
    }
  }
  options.onProgress?.(queries.length, queries.length);
  return { ids, failed };
}

/** Fetches advisory details a few at a time. Missing details are left out; the advisory id is still reported. */
export async function fetchDetails(client: OsvClient, ids: string[], options: RunOptions = {}) {
  const records = new Map<string, OsvRecord>(); const queue = [...ids]; let done = 0;
  options.onProgress?.(0, ids.length);
  await Promise.all(Array.from({ length: Math.min(detailConcurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const current = id;
      try { const record = await withRetry(() => client.vulnerability(current), options); if (record?.id === current) records.set(current, record); } catch { /* reported as details unavailable */ }
      options.onProgress?.(++done, ids.length);
    }
  }));
  return records;
}

// The non-null items of a field expected to be an array; anything else reads as empty.
const list = <T>(value: T[] | undefined): NonNullable<T>[] => Array.isArray(value) ? value.filter((v): v is NonNullable<T> => v != null) : [];
const aliasesOf = (record: OsvRecord | undefined) => list(record?.aliases).filter(a => typeof a === 'string' && a !== '');

/** Whether an affected entry names this package. PyPI names compare normalized (PEP 503); others ignore case. */
function samePackage(affected: OsvAffected, name: string, ecosystem: Ecosystem) {
  const pkg = affected.package;
  if (!pkg || pkg.ecosystem !== ecosystem || typeof pkg.name !== 'string') return false;
  return ecosystem === 'PyPI' ? normalizePython(pkg.name) === normalizePython(name) : pkg.name.toLowerCase() === name.toLowerCase();
}

/**
 * The lowest fixed version of the range containing this version, from the advisory's own data.
 * null means the advisory names no fix for it, which is not the same as "no fix exists".
 */
export function fixedVersion(record: OsvRecord, name: string, version: string, ecosystem: Ecosystem = 'npm') {
  const fixes: string[] = [];
  const compare = (a: string, b: string) => compareVersions(ecosystem, a, b);
  for (const affected of list(record.affected)) {
    if (!samePackage(affected, name, ecosystem)) continue;
    for (const range of list(affected.ranges)) {
      if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
      let introduced: string | null = null;
      for (const event of list(range.events)) {
        if (typeof event.introduced === 'string') introduced = event.introduced;
        const end = event.fixed ?? event.last_affected;
        if (typeof end !== 'string' || introduced === null) continue;
        const inside = (introduced === '0' || compare(version, introduced) >= 0) &&
          (event.fixed !== undefined ? compare(version, end) < 0 : compare(version, end) <= 0);
        if (inside && event.fixed !== undefined) fixes.push(event.fixed);
        introduced = null;
      }
    }
  }
  return fixes.sort(compare)[0] ?? null;
}

export const severityRank: Record<Severity, number> = { malicious: 5, critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };
export const higherSeverity = (a: Severity, b: Severity) => severityRank[a] >= severityRank[b] ? a : b;

/** One piece of severity information and where it came from. */
export interface SeverityEvidence { id: string; severity: Severity; source: string; score?: number | null; cvss?: string | null }
/** Advisory with the optional severity fields. */
export type ScoredAdvisory = Advisory & { severityScore?: number | null; severityReason?: string; severityConflict?: boolean; severityRetained?: boolean; severityEvidence?: SeverityEvidence[] };

const databases: [string, string][] = [['MAL-', 'OpenSSF Malicious Packages'], ['GHSA-', 'GitHub Advisory Database'], ['PYSEC-', 'PyPI Advisory Database'],
  ['GO-', 'Go Vulnerability Database'], ['RUSTSEC-', 'RustSec Advisory Database']];
const databaseOf = (id: string) => databases.find(([prefix]) => id.startsWith(prefix))?.[1] ?? `OSV (${id.split('-')[0]})`;
// Canonical id preference: malicious-package records, then GitHub's reviewed advisories, then the rest; ties by id.
const idRank = (id: string) => id.startsWith('MAL-') ? 0 : id.startsWith('GHSA-') ? 1 : 2;
export const compareAdvisoryIds = (a: string, b: string) => idRank(a) - idRank(b) || (a < b ? -1 : a > b ? 1 : 0);
const labels: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'moderate', medium: 'moderate', low: 'low' };
type Scored = { score: number; cvss: string | null };

// Severity arrays that apply to this package: the record's top level, and those of affected entries naming this package.
// scope names the affected package for the latter. Severity given for other packages of the same record is not used.
function severityLists(record: OsvRecord, name: string, ecosystem: Ecosystem) {
  const found: { entries: unknown[]; scope: string | null }[] = [];
  const malformed: (string | null)[] = [];
  const add = (value: unknown, scope: string | null) => {
    if (value == null) return;
    if (Array.isArray(value)) found.push({ entries: value, scope }); else malformed.push(scope);
  };
  add(record.severity, null);
  for (const affected of list(record.affected)) if (samePackage(affected, name, ecosystem)) add(affected.severity, `${affected.package!.ecosystem} ${affected.package!.name}`);
  return { found, malformed };
}

// Every severity claim of one record. Claims that cannot be used are returned as reasons instead.
// published lists the CVSS strings as written, shown when none could be scored.
function evidenceOf(id: string, record: OsvRecord | undefined, name: string, ecosystem: Ecosystem) {
  const evidence: SeverityEvidence[] = []; const reasons: string[] = []; const scores: Scored[] = []; const published: string[] = [];
  if (id.startsWith('MAL-')) evidence.push({ id, severity: 'malicious', source: databaseOf(id) });
  if (!record) return { evidence, reasons, scores, published };
  const label = record.database_specific?.severity;
  if (typeof label === 'string' && label.trim()) {
    const key = label.trim().toLowerCase();
    const severity = Object.hasOwn(labels, key) ? labels[key] : undefined;
    if (severity) evidence.push({ id, severity, source: databaseOf(id) });
    else reasons.push(`${id}: 重大度ラベル「${label}」は判別できません`);
  }
  // Some RustSec records publish a package-specific label rather than a CVSS vector.
  for (const affected of list(record.affected)) if (samePackage(affected, name, ecosystem)) {
    for (const [field, value] of [['ecosystem_specific', affected.ecosystem_specific?.severity], ['database_specific', affected.database_specific?.severity]] as const) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = value.trim().toLowerCase();
      if (Object.hasOwn(labels, key)) evidence.push({ id, severity: labels[key], source: `${databaseOf(id)}（${ecosystem} ${name} 向け・${field}）` });
      else reasons.push(`${id}: ${field} の重大度ラベル「${value}」は判別できません`);
    }
  }
  const { found, malformed } = severityLists(record, name, ecosystem);
  for (const scope of malformed) reasons.push(`${id}: severity が配列ではありません${scope ? `（${scope} 向け）` : ''}`);
  const seen = new Set<string>();
  for (const { entries, scope } of found) {
    const where = scope ? `（${scope} 向け）` : '';
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') { reasons.push(`${id}: 重大度の項目が不正です${where}`); continue; }
      const { type, score, source } = entry as { type?: unknown; score?: unknown; source?: unknown };
      const attribution = typeof source === 'string' && source.trim() ? ` / ${source.trim()}` : '';
      // Other kinds, such as Ubuntu priorities, are not CVSS and are left out.
      if (typeof type === 'string' && !type.startsWith('CVSS')) continue;
      const key = `${scope}\u0000${String(type)}\u0000${String(score)}\u0000${attribution}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof type === 'string' && typeof score === 'string' && score.trim()) published.push(score.trim());
      const scored = scoreSeverityEntry(type, score);
      if (!scored.ok) { reasons.push(`${id}: ${scored.reason}${where}`); continue; }
      scores.push({ score: scored.score, cvss: scored.vector });
      const kind = scored.version ? `CVSS v${scored.version}` : `CVSS v${type === 'CVSS_V4' ? 4 : 3} の数値`;
      if (scored.severity) evidence.push({ id, severity: scored.severity, source: `${kind}${where}${attribution}`, score: scored.score, cvss: scored.vector });
      else reasons.push(`${id}: CVSS 基本値 0.0（なし）${where}`);
    }
  }
  return { evidence, reasons, scores, published };
}

// One advisory from alias-related ids. members are the reported ids, canonical first; names are every id of the group.
function build(members: string[], names: string[], records: Map<string, OsvRecord>, name: string, version: string, ecosystem: Ecosystem): ScoredAdvisory {
  const [id] = members;
  const detailed = members.flatMap(m => records.get(m) ? [records.get(m)!] : []);
  const evidence: SeverityEvidence[] = []; const reasons: string[] = []; const scores: Scored[] = []; const published: string[] = [];
  for (const m of members) {
    const found = evidenceOf(m, records.get(m), name, ecosystem);
    evidence.push(...found.evidence); reasons.push(...found.reasons); scores.push(...found.scores); published.push(...found.published);
  }
  // Highest wins; on a tie the earlier claim (canonical record, database label before CVSS) names the source.
  const chosen = evidence.reduce<SeverityEvidence | null>((best, e) => !best || severityRank[e.severity] > severityRank[best.severity] ? e : best, null);
  const rated = evidence.filter(e => e.severity !== 'malicious');
  const conflict = new Set(rated.map(e => e.severity)).size > 1 || (rated.length > 0 && scores.some(s => s.score === 0));
  const top = scores.reduce<Scored | null>((best, s) => !best || s.score > best.score ? s : best, null);
  const fixes = detailed.flatMap(r => { const fix = fixedVersion(r, name, version, ecosystem); return fix ? [fix] : []; }).sort((a, b) => compareVersions(ecosystem, a, b));
  const missing = members.filter(m => !records.get(m));
  const unknown = [...reasons, ...(missing.length ? [`詳細を取得できませんでした（${missing.join(', ')}）`] : [])];
  // Claims that could not be used stay listed even when another one gave a severity, so the limitation remains visible.
  const severityReason = [
    ...(conflict ? [`重大度の記載が食い違うため最も高いものを採用（${rated.map(e => `${e.source} ${e.id}: ${e.severity}`).join(' / ')}）`] : []), ...unknown,
  ].join('; ') || (chosen ? undefined : '重大度の記載がありません');
  const text = (value: unknown) => typeof value === 'string' && value ? [value] : [];
  return {
    id, aliases: names.filter(n => n !== id).sort(compareAdvisoryIds),
    summary: [records.get(id), ...detailed].flatMap(r => text(r?.summary))[0] ?? '',
    severity: chosen?.severity ?? 'unknown', severitySource: chosen?.source ?? null,
    cvss: top?.cvss ?? published[0] ?? null,
    // Each record names the fix of the range containing this version; the highest one satisfies all of them.
    fixed: fixes.at(-1) ?? null,
    published: detailed.flatMap(r => text(r.published)).sort()[0] ?? null,
    modified: detailed.flatMap(r => text(r.modified)).sort().at(-1) ?? null,
    references: [...new Set(detailed.flatMap(r => list(r.references).flatMap(ref => text(ref.url))))].slice(0, 5),
    detailsAvailable: missing.length === 0,
    severityScore: top?.score ?? null, severityConflict: conflict, severityEvidence: evidence,
    ...(severityReason ? { severityReason } : {}),
  };
}

/** A single record's advisory. A withdrawn record is still described here; callers decide whether to drop it. */
export function toAdvisory(id: string, record: OsvRecord | undefined, name: string, version: string, ecosystem: Ecosystem = 'npm'): ScoredAdvisory {
  return build([id], [...new Set([id, ...aliasesOf(record)])],new Map(record ? [[id, record]] : []), name, version, ecosystem);
}

/**
 * Groups reported ids naming the same vulnerability, following aliases transitively, also through ids OSV did not report.
 * Withdrawn records add no alias links. Groups keep the order their first id was reported in.
 */
function groups(ids: string[], records: Map<string, OsvRecord>) {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) { parent.set(x, x); return x; } const root = find(p); parent.set(x, root); return root; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const listed = [...new Set(ids)];
  for (const id of listed) {
    find(id);
    const record = records.get(id);
    if (record && !record.withdrawn) for (const alias of aliasesOf(record)) union(id, alias);
  }
  const byRoot = new Map<string, { members: string[]; names: string[] }>();
  for (const id of listed) { const root = find(id); if (!byRoot.has(root)) byRoot.set(root, { members: [], names: [] }); byRoot.get(root)!.members.push(id); }
  for (const node of [...parent.keys()]) byRoot.get(find(node))?.names.push(node);
  return [...byRoot.values()].map(({ members, names }) => ({
    active: members.filter(m => !records.get(m)?.withdrawn).sort(compareAdvisoryIds),
    withdrawn: members.filter(m => records.get(m)?.withdrawn).sort(compareAdvisoryIds),
    names,
  }));
}

/**
 * One advisory per vulnerability reported for this package version. Aliases merge transitively and the canonical id prefers
 * MAL- then GHSA-, so neither the id nor the strongest severity depends on the order OSV listed them.
 * A group is left out only when every reported id is known to be withdrawn; an id without details is kept.
 */
export function mergeAdvisories(ids: string[], records: Map<string, OsvRecord>, name: string, version: string, ecosystem: Ecosystem = 'npm'): ScoredAdvisory[] {
  return groups(ids, records).filter(g => g.active.length).map(g => build(g.active, g.names, records, name, version, ecosystem));
}

/** Drops advisories that are aliases of another one in the same list, so GHSA and CVE ids are not counted twice. Returns canonical ids. */
export function dedupe(ids: string[], records: Map<string, OsvRecord>) {
  return groups(ids, records).map(g => g.active[0] ?? g.withdrawn[0]);
}

/** An offline client answering from fixed records, keyed by queryKey ("name@version" for npm). Used by tests and the browser test server. */
export function fixtureClient(fixture: Record<string, OsvRecord[]>): OsvClient {
  const records = new Map(Object.values(fixture).flat().map(record => [record.id, record]));
  return {
    async queryBatch(queries) { return queries.map(q => ({ ids: (fixture[queryKey(q.ecosystem, q.name, q.version)] || []).map(r => r.id) })); },
    async vulnerability(id) { const record = records.get(id); if (!record) throw new Error('not found'); return record; },
  };
}
