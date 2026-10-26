import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { dependencyContentId } from '../server/dependency-content.js';
import { summarize } from '../server/vulnerabilities.js';
import type { Dependency, DependencySnapshot, VulnerabilityCheck } from '../shared/types.js';

const deps: Dependency[] = [{ ecosystem: 'npm', name: 'example', version: '1.0.0', requested: '^1',
  direct: true, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '' }];
const snapshot = (projectId: string, readAt: string, hash = 'a'): DependencySnapshot => ({ projectId, readAt,
  status: 'complete', total: 1, direct: 1, files: [{ path: 'package-lock.json', lockfileVersion: 3,
    status: 'ok', message: '', hashes: { 'package.json': 'manifest', 'package-lock.json': hash } }] });

function fixture(run: (store: Store, id: string) => void) {
  const store = new Store(':memory:');
  try {
    const { projectIds: [id] } = store.import('content', [{ id: 'candidate', name: 'example', path: '/example',
      technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false }]);
    run(store, id);
  } finally { store.close(); }
}
function saveCheck(store: Store, id: string, legacy = false) {
  const s = store.dependencies(id).snapshot!;
  const check: VulnerabilityCheck = { projectId: id, checkedAt: '2026-10-25T01:00:00Z',
    snapshotReadAt: s.readAt, ...(!legacy ? { snapshotContentId: s.contentId } : {}),
    status: 'complete', queried: 1, failed: 0, notSent: {}, findings: [] };
  store.saveVulnerabilityCheck(check);
}
function stale(store: Store, id: string) {
  const s = store.dependencies(id).snapshot!;
  return summarize(store.vulnerabilityCheck(id)!, s.readAt, s.contentId).stale;
}

test('同じ内容の再読込では日時を更新しても結果を維持し、変更・復元は内容で判定', () => fixture((store, id) => {
  store.saveDependencies(snapshot(id, 'first'), deps); saveCheck(store, id);
  const checkedAt = store.vulnerabilityCheck(id)!.checkedAt;
  store.saveDependencies(snapshot(id, 'second'), deps);
  assert.equal(store.dependencies(id).snapshot!.readAt, 'second');
  assert.equal(stale(store, id), false);
  assert.equal(store.vulnerabilityCheck(id)!.checkedAt, checkedAt, 'reading is not a new OSV check');
  store.saveDependencies(snapshot(id, 'second', 'changed'), deps);
  assert.equal(stale(store, id), true, 'content changes count even within the same timestamp');
  store.saveDependencies(snapshot(id, 'third'), deps);
  assert.equal(stale(store, id), false, 'returning to checked content restores the matching result');
}));

test('読み取り失敗・ファイル範囲・宣言や解決版の変更を見逃さない', () => {
  const s = snapshot('p', 'first'); const baseline = dependencyContentId(s, deps);
  assert.equal(dependencyContentId({ ...s, readAt: 'later', files: [{ ...s.files[0], hashes: { 'package-lock.json': 'a', 'package.json': 'manifest' } }] }, deps), baseline);
  for (const changed of [
    { ...s, status: 'failed' as const },
    { ...s, files: [{ ...s.files[0], status: 'invalid' as const }] },
    { ...s, files: [] },
    { ...s, files: [{ ...s.files[0], hashes: { ...s.files[0].hashes, 'package.json': 'changed' } }] },
  ]) assert.notEqual(dependencyContentId(changed, deps), baseline);
  assert.notEqual(dependencyContentId(s, [{ ...deps[0], version: '2.0.0' }]), baseline);
});

test('古い結果は元の依存内容が特定できるときだけ再読込後も引き継ぐ', () => fixture((store, id) => {
  store.saveDependencies(snapshot(id, 'original'), deps); saveCheck(store, id, true);
  store.saveDependencies(snapshot(id, 'later'), deps);
  assert.equal(stale(store, id), false);
  assert.ok(store.vulnerabilityCheck(id)!.snapshotContentId);
  saveCheck(store, id, true);
  const check = store.vulnerabilityCheck(id)!;
  store.saveVulnerabilityCheck({ ...check, snapshotReadAt: 'unknown-older-read' });
  store.saveDependencies(snapshot(id, 'latest'), deps);
  assert.equal(stale(store, id), true);
  assert.equal(store.vulnerabilityCheck(id)!.snapshotContentId, undefined);
}));
