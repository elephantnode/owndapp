import type { Project, Severity } from '../shared/types';

/**
 * Problems that need action, most urgent first. Triage (no lifecycle or purpose yet) is kept apart:
 * a freshly registered catalog is all untriaged, and listing it would bury the real problems.
 */
export type IssueKind = 'vulnerable' | 'recheck' | 'missing' | 'excluded' | 'read-failed';
export const issueKinds: IssueKind[] = ['vulnerable', 'recheck', 'missing', 'excluded', 'read-failed'];

export function issuesOf(p: Project): IssueKind[] {
  const issues: IssueKind[] = [];
  if (p.vulnerabilities?.count) issues.push('vulnerable');
  if (needsRecheck(p)) issues.push('recheck');
  if (p.missing) issues.push('missing');
  if (p.excluded) issues.push('excluded');
  if (p.evidence.some(e => e.detail.includes('失敗')) || unreadable(p)) issues.push('read-failed');
  return issues;
}
export const hasIssue = (p: Project) => issuesOf(p).length > 0;
/** A dependency file in a supported format could not be read. Unsupported formats are out of scope instead. */
export const unreadable = (p: Project) => (p.dependencyUnreadable ?? 0) > 0;
/**
 * The last check is out of date, or something a check covers was left out (a failed query, an unreadable file).
 * A check left partial only by unsupported formats stays partial, so it never resolves a finding, but checking again would not change it.
 */
export const needsRecheck = (p: Project) => !!p.vulnerabilities && (p.vulnerabilities.stale || (p.vulnerabilities.status === 'partial' && (!!p.vulnerabilities.queryFailed || unreadable(p))));
export const needsTriage = (p: Project) => p.lifecycle === 'untriaged' || !p.purpose;
/** Out of scope for vulnerability checks: dependencies were read and none can be sent (no lockfile, unsupported format, only Git or local references). */
export const outOfScope = (p: Project) => p.diagnosable === false;
/** Diagnosable, or not read yet: a check reads dependencies first, so those are still worth sending. */
export const diagnosable = (p: Project) => !outOfScope(p);
/** Diagnosable dependencies were read but never checked for known vulnerabilities. */
export const unchecked = (p: Project) => !p.vulnerabilities && p.diagnosable === true;
export const unread = (p: Project) => !p.dependencyStatus;

const severityRank: Record<Severity, number> = { malicious: 5, critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

/** Active (not archived) projects grouped by issue. A project appears under each of its issues. */
export function groupIssues(projects: Project[]) {
  const active = projects.filter(p => p.lifecycle !== 'archived');
  const groups = new Map<IssueKind, Project[]>(issueKinds.map(kind => [kind, []]));
  for (const p of active) for (const kind of issuesOf(p)) groups.get(kind)!.push(p);
  groups.get('vulnerable')!.sort((a, b) => severityRank[b.vulnerabilities!.highest || 'unknown'] - severityRank[a.vulnerabilities!.highest || 'unknown'] ||
    b.vulnerabilities!.count - a.vulnerabilities!.count || a.name.localeCompare(b.name));
  return {
    groups,
    issueCount: active.filter(hasIssue).length,
    unchecked: active.filter(unchecked),
    unread: active.filter(unread),
    untriaged: active.filter(p => p.lifecycle === 'untriaged'),
    noPurpose: active.filter(p => !p.purpose),
    triageCount: active.filter(needsTriage).length,
  };
}
