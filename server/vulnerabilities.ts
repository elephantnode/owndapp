import type { Store } from './store.js';
import { posix } from 'node:path';
import { dependencyStatusOf, unreadableFiles } from './dependencies.js';
import { scannerReadable, type ScannedPackage } from './osv-scanner.js';
import { compareAdvisoryIds, fetchDetails, higherSeverity, mergeAdvisories, osvEndpoint, queryAll, queryKey, sendableSources, severityRank,
  type OsvClient, type OsvQuery, type RunOptions, type ScoredAdvisory } from './osv.js';
import type { Dependency, DependencyScope, DependencySnapshot, Ecosystem, FindingVia, LockFileResult, Project, ResponseRecord, Severity, VulnerabilityCheck, VulnerabilityFinding, VulnerabilitySummary } from '../shared/types.js';

type Planned = { project: Project; contentId?: string; readAt: string; status: DependencySnapshot['status']; files: LockFileResult[]; sendable: Dependency[]; notSent: Record<string, number> };

/** osv-scanner as a check source. Absent when the tool is missing or not enabled; then unsupported files and images stay unchecked. */
export interface ScannerHooks {
  lockfile(project: Project, file: string): Promise<ScannedPackage[]>;
  image(reference: string): Promise<{ imageId: string; packages: ScannedPackage[] }>;
}
/** Lockfiles owndapp does not parse that osv-scanner can check. */
export const scannerFiles = (files: LockFileResult[]) => files.filter(f => f.status === 'unsupported' && scannerReadable.test(posix.basename(f.path)));

/** Why a dependency stays local, or null when a check may send it. Also decides whether a project is diagnosable at all. */
export const notSentReason = (d: Pick<Dependency, 'version' | 'ecosystem' | 'source'>) =>
  !d.version ? 'no-version' : d.ecosystem === 'crates.io' && ['other-registry', 'registry-unrecorded', 'unknown'].includes(d.source) ? 'rust-source-unverified' : sendableSources.has(d.source) ? null : d.source;

// Splits each project's recorded dependencies into what may be sent and what stays local, by reason.
function plan(store: Store, ids: string[]) {
  const projects: Planned[] = []; const notRead: Project[] = [];
  for (const id of new Set(ids)) {
    const project = store.project(id);
    const { snapshot, dependencies } = store.dependencies(id);
    if (!snapshot) { notRead.push(project); continue; }
    const notSent: Record<string, number> = {};
    const sendable = dependencies.filter(d => {
      const reason = notSentReason(d);
      if (reason) notSent[reason] = (notSent[reason] || 0) + 1;
      return !reason;
    });
    projects.push({ project, contentId: snapshot.contentId, readAt: snapshot.readAt, status: dependencyStatusOf(snapshot.files), files: snapshot.files, sendable, notSent });
  }
  const queries = new Map<string, OsvQuery>();
  for (const { sendable } of projects) for (const d of sendable) queries.set(queryKey(d.ecosystem, d.name, d.version!), { ecosystem: d.ecosystem, name: d.name, version: d.version! });
  return { projects, notRead, queries: [...queries.values()] };
}

/** What a check would send, for the confirmation shown before anything leaves this Mac. */
export function preview(store: Store, ids: string[], scanner = false) {
  const { projects, notRead, queries } = plan(store, ids);
  const scannable = (p: Planned) => scanner && (scannerFiles(p.files).length > 0 || (p.project.images?.length ?? 0) > 0);
  const notSent: Record<string, number> = {};
  for (const p of projects) for (const [reason, count] of Object.entries(p.notSent)) notSent[reason] = (notSent[reason] || 0) + count;
  // Projects that were read but have nothing to send, e.g. no lockfile. Shown so an empty check is explained.
  const nothingToSend = projects.filter(p => !p.sendable.length && p.status === 'complete' && !scannable(p)).map(p => ({ name: p.project.name, reason: p.status === 'no-lock' ? 'no-lock' : p.status === 'failed' ? 'failed' : 'no-sendable' }));
  // Read again before the check, since a lockfile may have appeared or been fixed since.
  const reread = projects.filter(p => p.status !== 'complete').map(p => p.project.name);
  const byEcosystem: Partial<Record<Ecosystem, number>> = {};
  for (const q of queries) byEcosystem[q.ecosystem] = (byEcosystem[q.ecosystem] || 0) + 1;
  // What osv-scanner would check: its own reading of these files and images, so the package count is only known afterwards.
  const scannerFormats: Record<string, number> = {};
  if (scanner) for (const p of projects) for (const f of scannerFiles(p.files)) scannerFormats[f.format ?? posix.basename(f.path)] = (scannerFormats[f.format ?? posix.basename(f.path)] || 0) + 1;
  const images = scanner ? projects.flatMap(p => (p.project.images ?? []).map(image => ({ project: p.project.name, image }))) : [];
  return { destination: osvEndpoint, projects: projects.length, notRead: notRead.map(p => p.name), reread, packageVersions: queries.length, byEcosystem, notSent, nothingToSend,
    scanner: scanner ? { formats: scannerFormats, images } : null };
}

export type CheckResult = { id: string; name: string; status: 'complete' | 'partial' | 'failed' | 'kept-previous' | 'not-read' | 'nothing-to-check'; count: number };

/**
 * Checks the projects' recorded dependencies against OSV. A failed first check is not saved; later failures retain the earlier findings with a failed-attempt marker.
 * A partial result (failed queries or details) saves what it newly found plus earlier findings it cannot rule out, marked retained,
 * so a failure is never shown as "no vulnerabilities". Only a complete check resolves response records.
 */
export type CheckPhase = 'querying' | 'details' | 'scanner';
export async function check(store: Store, client: OsvClient, ids: string[],
  { onProgress, scanner, ...options }: Omit<RunOptions, 'onProgress'> & { onProgress?: (phase: CheckPhase, done: number, total: number) => void; scanner?: ScannerHooks } = {}) {
  const { projects, notRead, queries } = plan(store, ids);
  const scannerTotal = scanner ? projects.reduce((n, p) => n + scannerFiles(p.files).length + (p.project.images?.length ?? 0), 0) : 0;
  let scannerDone = 0;
  const outcome = await queryAll(client, queries, { ...options, onProgress: (done, total) => onProgress?.('querying', done, total) });
  const advisoryIds = [...new Set([...outcome.ids.values()].flat())];
  const records = await fetchDetails(client, advisoryIds, { ...options, onProgress: (done, total) => onProgress?.('details', done, total) });
  const results: CheckResult[] = notRead.map(p => ({ id: p.id, name: p.name, status: 'not-read', count: 0 }));
  const now = new Date().toISOString();
  for (const { project, contentId, readAt, files, sendable, notSent } of projects) {
    // One finding per package version. The same version may appear several times, directly or not, in production or development.
    const occurrences = new Map<string, Dependency[]>();
    for (const d of sendable) { const key = queryKey(d.ecosystem, d.name, d.version!); occurrences.set(key, [...(occurrences.get(key) || []), d]); }
    const keys = [...occurrences.keys()];
    const failed = keys.filter(key => outcome.failed.has(key)).length;
    const lockfiles = scanner ? scannerFiles(files).map(f => f.path) : [];
    const images = scanner ? project.images ?? [] : [];
    // Nothing could be sent (no lockfile, only Git or local dependencies): nothing was judged, so no "no vulnerabilities" result is stored.
    if (!keys.length && !lockfiles.length && !images.length) { results.push({ id: project.id, name: project.name, status: 'nothing-to-check', count: 0 }); continue; }
    const previous = store.vulnerabilityCheck(project.id) as Check | null;
    // Keep the last observation date and content identity, but never leave a failed attempt labelled complete.
    if (keys.length && failed === keys.length) {
      if (previous) {
        store.saveVulnerabilityCheck({ ...previous, status: 'partial', attemptedAt: now, queried: 0, failed, detailsFailed: 0, notSent,
          findings: previous.findings.map(f => ({ ...f, retained: true, observedAt: f.observedAt ?? previous.checkedAt })) });
      }
      results.push({ id: project.id, name: project.name, status: previous ? 'partial' : 'failed', count: previous ? advisoryCount(previous) : 0 });
      continue;
    }
    const prior = priorByKey(previous);
    const responded = new Set(store.responses(project.id).map(r => r.advisoryId));
    const detailsMissing = new Set<string>();
    const findings: Finding[] = [];
    const dependencies = new Map<string, Dependency>();
    const matched = new Set<Prior>();
    for (const [key, list] of occurrences) {
      const dependency = representative(list);
      dependencies.set(key, dependency);
      if (outcome.failed.has(key)) continue;
      const ids = outcome.ids.get(key) || [];
      for (const id of ids) if (!records.has(id)) detailsMissing.add(id);
      const used = new Set<string>();
      const advisories = mergeAdvisories(ids, records, dependency.name, dependency.version!, dependency.ecosystem)
        .map(advisory => continueIdentity(advisory, prior.get(key) ?? [], responded, matched, used));
      if (advisories.length) findings.push({ dependency, advisories, observedAt: now });
    }
    // osv-scanner reads what owndapp does not: one lockfile or image at a time, so one failure leaves the others checked.
    const covered: string[] = []; const imageIds: Record<string, string> = {}; const scannerFailed: { target: string; message: string }[] = [];
    const scanned: { via: FindingVia; packages: ScannedPackage[] }[] = [];
    for (const file of lockfiles) {
      try { scanned.push({ via: { tool: 'osv-scanner', file }, packages: await scanner!.lockfile(project, file) }); covered.push(file); }
      catch (error) { scannerFailed.push({ target: file, message: (error as Error).message }); }
      onProgress?.('scanner', ++scannerDone, scannerTotal);
    }
    for (const image of images) {
      try { const result = await scanner!.image(image); imageIds[image] = result.imageId; scanned.push({ via: { tool: 'osv-scanner', image, imageId: result.imageId }, packages: result.packages }); }
      catch (error) { scannerFailed.push({ target: image, message: (error as Error).message }); }
      onProgress?.('scanner', ++scannerDone, scannerTotal);
    }
    for (const { via, packages } of scanned) for (const pkg of packages) {
      if (!pkg.records.length) continue;
      // osv-scanner returns the full records, so no separate detail fetch is needed. Its ecosystem may be outside Ecosystem (Pub, Debian:12...).
      const ecosystem = pkg.ecosystem as Ecosystem;
      const key = queryKey(ecosystem, pkg.name, pkg.version);
      const records = new Map(pkg.records.map(record => [record.id, record]));
      const dependency: Dependency = { ecosystem, name: pkg.name, version: pkg.version, requested: null, direct: false, scope: 'unknown', source: 'registry', file: via.file ?? via.image ?? '', component: '', via };
      const used = new Set<string>();
      const advisories = mergeAdvisories([...records.keys()], records, pkg.name, pkg.version, ecosystem)
        .map(advisory => continueIdentity(advisory, prior.get(key) ?? [], responded, matched, used));
      if (advisories.length) findings.push({ dependency, advisories, observedAt: now, via });
    }
    // Like a failed query, a first attempt that judged nothing at all is not saved as a result.
    if (!previous && keys.length - failed === 0 && !covered.length && !Object.keys(imageIds).length) {
      results.push({ id: project.id, name: project.name, status: 'failed', count: 0 }); continue;
    }
    // Anything left unchecked keeps the check partial so it never resolves a finding: an unreadable file, an unsupported one osv-scanner
    // did not cover, or a linked image that could not be checked.
    // A manifest osv-scanner does not read is covered by the lockfile beside it that records its resolved versions.
    const lockOf: Record<string, string> = { 'Package.swift': 'Package.resolved', 'build.gradle': 'gradle.lockfile', 'build.gradle.kts': 'gradle.lockfile' };
    const coveredFile = (path: string) => covered.includes(path) || (posix.basename(path) in lockOf && covered.includes(posix.join(posix.dirname(path), lockOf[posix.basename(path)])));
    const uncovered = files.some(f => f.status === 'unsupported' && !coveredFile(f.path));
    const imagesUnchecked = (project.images ?? []).some(image => !(image in imageIds));
    const status = failed || detailsMissing.size || unreadableFiles(files).length || uncovered || imagesUnchecked ? 'partial' : 'complete';
    // Only a complete check clears anything. A partial one keeps every earlier advisory it did not see again: its query may have
    // failed, or a detail it could not fetch may have been needed to recognise it under another id.
    if (status === 'partial') for (const [key, before] of prior) {
      const kept = before.filter(p => !matched.has(p) && !findings.some(f => queryKeyOf(f.dependency) === key && f.advisories.some(a => a.id === p.advisory.id)));
      if (kept.length) findings.push({ dependency: dependencies.get(key) ?? kept[0].dependency, advisories: kept.map(p => p.advisory), retained: true, observedAt: earliest(kept), ...(kept[0].via && { via: kept[0].via }) });
    }
    const result: Check = { projectId: project.id, checkedAt: now, attemptedAt: now, snapshotReadAt: readAt, snapshotContentId: contentId, status,
      queried: keys.length - failed, failed, detailsFailed: detailsMissing.size, notSent, findings,
      ...(scanner && (lockfiles.length || images.length) && { scanner: { files: covered, images: imageIds, failed: scannerFailed } }) };
    store.saveVulnerabilityCheck(result);
    // Only a complete check may resolve anything: a partial one may simply have missed it.
    if (result.status === 'complete') store.reconcileResponses(project.id, snapshots(previous), snapshots(result));
    results.push({ id: project.id, name: project.name, status: result.status, count: advisoryCount(result) });
  }
  return { results, queried: queries.length - outcome.failed.size, failed: outcome.failed.size };
}

type Finding = VulnerabilityFinding & { advisories: ScoredAdvisory[]; retained?: boolean; observedAt?: string };
type Check = Omit<VulnerabilityCheck, 'findings'> & { findings: Finding[]; detailsFailed?: number; attemptedAt?: string };
type Prior = { advisory: ScoredAdvisory; observedAt: string; dependency: Dependency; via?: FindingVia };
const earliest = (list: Prior[]) => list.map(p => p.observedAt).sort()[0];
const queryKeyOf = (d: Dependency) => queryKey(d.ecosystem, d.name, d.version ?? '');

// Conservative merged occurrence: direct if any is direct; development only when every occurrence is development.
const scopeOrder: DependencyScope[] = ['prod', 'unknown', 'optional', 'peer', 'dev'];
function representative(list: Dependency[]): Dependency {
  const first = [...list].sort((a, b) => Number(b.direct) - Number(a.direct))[0];
  const scope = scopeOrder.find(s => list.some(d => d.scope === s)) ?? first.scope;
  return { ...first, direct: list.some(d => d.direct), scope };
}

function priorByKey(previous: Check | null) {
  const map = new Map<string, Prior[]>();
  for (const finding of previous?.findings ?? []) {
    const d = finding.dependency; if (!d.version) continue;
    const key = queryKeyOf(d);
    const list = map.get(key) ?? [];
    for (const advisory of finding.advisories) if (!list.some(p => p.advisory.id === advisory.id)) list.push({ advisory, observedAt: finding.observedAt ?? previous!.checkedAt, dependency: d, via: finding.via });
    map.set(key, list);
  }
  return map;
}

/**
 * Keeps the id an earlier check used when alias merging now picks another canonical id, so response records stay attached.
 * An id with a response record wins, then the usual preference. Missing details keep the earlier, stronger severity.
 */
function continueIdentity(advisory: ScoredAdvisory, before: Prior[], responded: Set<string>, matched: Set<Prior>, used: Set<string>): ScoredAdvisory {
  const names = new Set([advisory.id, ...advisory.aliases]);
  const same = before.filter(p => !matched.has(p) && (names.has(p.advisory.id) || p.advisory.aliases.some(a => names.has(a))));
  for (const p of same) matched.add(p);
  const candidates = [...new Set([...same.map(p => p.advisory.id), ...[...names].filter(n => responded.has(n))])].filter(id => !used.has(id))
    .sort((a, b) => Number(responded.has(b)) - Number(responded.has(a)) || compareAdvisoryIds(a, b));
  let next = advisory;
  const id = candidates[0];
  if (id && id !== advisory.id) next = { ...advisory, id, aliases: [...new Set([...advisory.aliases, advisory.id])].filter(a => a !== id).sort(compareAdvisoryIds) };
  used.add(next.id);
  const strongest = same.map(p => p.advisory).sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0];
  if (!advisory.detailsAvailable && strongest && severityRank[strongest.severity] > severityRank[advisory.severity]) {
    next = { ...next, severity: strongest.severity, severitySource: strongest.severitySource, severityScore: strongest.severityScore ?? null,
      cvss: strongest.cvss, severityEvidence: [...(strongest.severityEvidence ?? []), ...(next.severityEvidence ?? [])].filter((e, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(e)) === i), severityConflict: !!strongest.severityConflict || !!next.severityConflict,
      summary: next.summary || strongest.summary, fixed: next.fixed ?? strongest.fixed, published: next.published ?? strongest.published,
      modified: next.modified ?? strongest.modified, references: next.references.length ? next.references : strongest.references,
      severityRetained: true, severityReason: `詳細を取得できなかったため、${strongest.id} の前回の重大度を維持しています` };
  }
  return next;
}

/** Advisory id -> what it was and which package it was found in, for the response records. */
export function snapshots(check: VulnerabilityCheck | null) {
  const map = new Map<string, ResponseRecord['advisory']>();
  for (const finding of check?.findings ?? []) for (const a of finding.advisories) {
    if (!map.has(a.id)) map.set(a.id, { id: a.id, summary: a.summary, severity: a.severity, fixed: a.fixed, package: finding.dependency.name, version: finding.dependency.version, ecosystem: finding.dependency.ecosystem });
  }
  return map;
}

export const advisoryCount = (check: VulnerabilityCheck) => new Set(check.findings.flatMap(f => f.advisories.map(a => a.id))).size;

export function summarize(check: VulnerabilityCheck, dependenciesReadAt: string | undefined, contentId?: string): VulnerabilitySummary {
  const highest = check.findings.flatMap(f => f.advisories.map(a => a.severity)).reduce<Severity | null>((a, b) => a ? higherSeverity(a, b) : b, null);
  return { checkedAt: check.checkedAt, status: check.status, count: advisoryCount(check), highest, stale: check.snapshotContentId && contentId ? check.snapshotContentId !== contentId : dependenciesReadAt !== check.snapshotReadAt, queryFailed: check.failed > 0 || (check.detailsFailed ?? 0) > 0 };
}
