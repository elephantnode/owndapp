import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosable, groupIssues, issuesOf } from '../src/attention.js';
import type { Project } from '../shared/types.js';

const p = (name: string, extra: Partial<Project> = {}) => ({ id: name, name, path: `/x/${name}`, evidence: [], lifecycle: 'untriaged', purpose: '', ...extra }) as unknown as Project;
const checked = (count: number, highest: string | null, extra = {}) =>
  ({ checkedAt: '2026-10-20T00:00:00Z', status: 'complete', count, highest, stale: false, ...extra }) as Project['vulnerabilities'];

test('整理が済んでいないだけのプロジェクトは要対応に入れず、問題ごとに分ける', () => {
  const projects = [
    p('fresh', { dependencyStatus: 'no-lock', diagnosable: false }),
    p('vuln-low', { dependencyStatus: 'complete', vulnerabilities: checked(1, 'low') }),
    p('vuln-critical', { dependencyStatus: 'complete', vulnerabilities: checked(3, 'critical'), lifecycle: 'maintained', purpose: '社内向け' }),
    p('stale', { dependencyStatus: 'complete', vulnerabilities: checked(0, null, { stale: true }) }),
    p('gone', { missing: true }),
    p('broken', { dependencyStatus: 'failed', dependencyUnreadable: 1 }),
    p('partial-read', { dependencyStatus: 'partial', dependencyUnreadable: 1, diagnosable: true }),
    p('swift-only', { dependencyStatus: 'failed', dependencyUnsupported: 1, diagnosable: false, lifecycle: 'maintained', purpose: '未対応形式だけ' }),
    p('npm-and-swift', { dependencyStatus: 'partial', dependencyUnsupported: 1, diagnosable: true, vulnerabilities: checked(0, null, { status: 'partial' }), lifecycle: 'maintained', purpose: '一部が未対応形式' }),
    p('query-failed', { dependencyStatus: 'complete', diagnosable: true, vulnerabilities: checked(0, null, { status: 'partial', queryFailed: true }), lifecycle: 'maintained', purpose: '照会の一部が失敗' }),
    p('todo', { dependencyStatus: 'complete', diagnosable: true }),
    p('git-only', { dependencyStatus: 'complete', diagnosable: false, lifecycle: 'maintained', purpose: 'Gitの依存だけ' }),
    p('archived-vuln', { lifecycle: 'archived', vulnerabilities: checked(2, 'high') }),
  ];
  const result = groupIssues(projects);
  assert.deepEqual(issuesOf(projects[0]), []);
  assert.equal(result.issueCount, 7, 'triage alone is not an issue, and archived projects are left out');
  assert.deepEqual(result.groups.get('vulnerable')!.map(x => x.name), ['vuln-critical', 'vuln-low'], 'most severe first');
  assert.deepEqual(result.groups.get('recheck')!.map(x => x.name), ['stale', 'query-failed'], 'a check left partial only by unsupported formats is not rechecked');
  assert.deepEqual(result.groups.get('missing')!.map(x => x.name), ['gone']);
  assert.deepEqual(result.groups.get('read-failed')!.map(x => x.name), ['broken', 'partial-read'], 'an unsupported format is out of scope, not a read failure');
  assert.deepEqual(issuesOf(projects.find(x => x.name === 'swift-only')!), []);
  assert.deepEqual(issuesOf(projects.find(x => x.name === 'npm-and-swift')!), []);
  assert.deepEqual(result.unchecked.map(x => x.name), ['partial-read', 'todo'], 'only diagnosable projects wait for a check');
  assert.deepEqual(projects.filter(x => !diagnosable(x)).map(x => x.name), ['fresh', 'swift-only', 'git-only'], 'read with nothing to send is out of scope; never read is not');
  assert.deepEqual(result.unread.map(x => x.name), ['gone']);
  assert.equal(result.triageCount, 7);
});
