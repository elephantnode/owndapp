import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFindings, severityCounts } from '../src/findings.js';
import type { Advisory, Dependency, VulnerabilityFinding } from '../shared/types.js';

const dep = (name: string, version: string): Dependency =>
  ({ ecosystem: 'npm', name, version, requested: null, direct: false, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '' });
const advisory = (id: string, severity: Advisory['severity'], fixed: string | null): Advisory =>
  ({ id, aliases: [], summary: '', severity, severitySource: null, cvss: null, fixed, published: null, modified: null, references: [], detailsAvailable: true });
const finding = (name: string, version: string, advisories: Advisory[]): VulnerabilityFinding => ({ dependency: dep(name, version), advisories });

test('脆弱性は依存の版ごとにまとめ、最も重いものから並べて、最も高い修正版を示す', () => {
  const groups = groupFindings([
    finding('nanoid', '3.0.2', [advisory('GHSA-c', 'moderate', '3.0.8')]),
    finding('lodash', '4.17.15', [advisory('GHSA-a', 'high', '4.17.9'), advisory('GHSA-b', 'critical', '4.17.21'), advisory('GHSA-x', 'low', null)]),
    finding('minimist', '1.2.0', [advisory('GHSA-d', 'moderate', null), advisory('GHSA-e', 'moderate', '1.2.6')]),
    finding('empty', '1.0.0', []),
  ]);
  assert.deepEqual(groups.map(g => g.dependency.name), ['lodash', 'minimist', 'nanoid'], 'severity, then advisory count; nothing for an empty finding');
  assert.deepEqual(groups[0].advisories.map(a => a.id), ['GHSA-b', 'GHSA-a', 'GHSA-x']);
  assert.equal(groups[0].highest, 'critical');
  assert.equal(groups[0].fixed, '4.17.21', 'compared as versions, not text');
  assert.equal(groups[0].withoutFix, 1);
  assert.equal(groups[2].fixed, '3.0.8');
  assert.deepEqual(severityCounts(groups), [['critical', 1], ['high', 1], ['moderate', 3], ['low', 1]]);
});

test('部分照会の保持分は同じ依存版へまとめ、保持した情報として示す', () => {
  const fresh = finding('pkg', '1.0.0', [advisory('GHSA-new', 'critical', '1.0.2')]);
  const retained = { ...finding('pkg', '1.0.0', [advisory('GHSA-old', 'high', '1.0.1')]), retained: true };
  const groups = groupFindings([fresh, retained]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].advisories.map(a => a.id), ['GHSA-new', 'GHSA-old']);
  assert.equal(groups[0].advisories[1].severityRetained, true);
  assert.equal(groups[0].fixed, '1.0.2');
  assert.equal(fresh.advisories[0].severityRetained, undefined, 'stored input is not mutated');
});
