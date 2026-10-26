import { compareVersions } from '../shared/semver';
import { severityRank } from '../shared/priority';
import type { Advisory, Dependency, Severity, VulnerabilityFinding } from '../shared/types';

/** Advisories for one dependency version: the fix is one upgrade, so the detail page lists them together. */
export interface FindingGroup {
  dependency: Dependency;
  advisories: Advisory[];
  highest: Severity;
  /** Highest fixed version named by the advisories. null when none names one. */
  fixed: string | null;
  /** Advisories that name no fixed version, so the upgrade above may not cover them. */
  withoutFix: number;
}

// Most severe group first, then the one with more advisories; advisories inside a group the same way.
export function groupFindings(findings: VulnerabilityFinding[]): FindingGroup[] {
  const byVersion = new Map<string, VulnerabilityFinding>();
  for (const finding of findings) {
    const d = finding.dependency;
    const key = JSON.stringify([d.ecosystem, d.name, d.version]);
    const group = byVersion.get(key) ?? { dependency: d, advisories: [] };
    for (const a of finding.advisories) {
      const advisory = finding.retained ? { ...a, severityRetained: true } : a;
      const existing = group.advisories.findIndex(previous => previous.id === a.id);
      if (existing < 0) group.advisories.push(advisory);
      else if (severityRank[advisory.severity] > severityRank[group.advisories[existing].severity]) group.advisories[existing] = advisory;
    }
    byVersion.set(key, group);
  }
  return [...byVersion.values()].filter(f => f.advisories.length).map(f => {
    const advisories = [...f.advisories].sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
    const fixes = advisories.flatMap(a => a.fixed ? [a.fixed] : []).sort((a, b) => compareVersions(f.dependency.ecosystem, a, b));
    return { dependency: f.dependency, advisories, highest: advisories[0].severity, fixed: fixes.at(-1) ?? null, withoutFix: advisories.length - fixes.length };
  }).sort((a, b) => severityRank[b.highest] - severityRank[a.highest] || b.advisories.length - a.advisories.length || a.dependency.name.localeCompare(b.dependency.name));
}

/** Advisory counts by severity, most severe first, leaving out severities with none. */
export function severityCounts(groups: FindingGroup[]): [Severity, number][] {
  const counts = new Map<Severity, number>();
  for (const a of groups.flatMap(g => g.advisories)) counts.set(a.severity, (counts.get(a.severity) || 0) + 1);
  return [...counts].sort(([a], [b]) => severityRank[b] - severityRank[a]);
}
