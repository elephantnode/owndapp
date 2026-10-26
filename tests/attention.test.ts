import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIssues, issuesOf } from '../src/attention.js';
import type { Project } from '../shared/types.js';

const p = (name: string, extra: Partial<Project> = {}) => ({ id: name, name, path: `/x/${name}`, evidence: [], lifecycle: 'untriaged', purpose: '', ...extra }) as unknown as Project;
const checked = (count: number, highest: string | null, extra = {}) =>
  ({ checkedAt: '2026-10-20T00:00:00Z', status: 'complete', count, highest, stale: false, ...extra }) as Project['vulnerabilities'];

test('整理が済んでいないだけのプロジェクトは要対応に入れず、問題ごとに分ける', () => {
  const projects = [
    p('fresh', { dependencyStatus: 'no-lock' }),
    p('vuln-low', { dependencyStatus: 'complete', vulnerabilities: checked(1, 'low') }),
    p('vuln-critical', { dependencyStatus: 'complete', vulnerabilities: checked(3, 'critical'), lifecycle: 'maintained', purpose: '社内向け' }),
    p('stale', { dependencyStatus: 'complete', vulnerabilities: checked(0, null, { stale: true }) }),
    p('gone', { missing: true }),
    p('broken', { dependencyStatus: 'failed' }),
    p('partial-read', { dependencyStatus: 'partial' }),
    p('todo', { dependencyStatus: 'complete' }),
    p('archived-vuln', { lifecycle: 'archived', vulnerabilities: checked(2, 'high') }),
  ];
  const result = groupIssues(projects);
  assert.deepEqual(issuesOf(projects[0]), []);
  assert.equal(result.issueCount, 6, 'triage alone is not an issue, and archived projects are left out');
  assert.deepEqual(result.groups.get('vulnerable')!.map(x => x.name), ['vuln-critical', 'vuln-low'], 'most severe first');
  assert.deepEqual(result.groups.get('recheck')!.map(x => x.name), ['stale']);
  assert.deepEqual(result.groups.get('missing')!.map(x => x.name), ['gone']);
  assert.deepEqual(result.groups.get('read-failed')!.map(x => x.name), ['broken', 'partial-read']);
  assert.deepEqual(result.unchecked.map(x => x.name), ['partial-read', 'todo']);
  assert.deepEqual(result.unread.map(x => x.name), ['gone']);
  assert.equal(result.triageCount, 7);
});
