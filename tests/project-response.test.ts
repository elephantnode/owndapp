import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import { projectResponseSummary } from '../shared/project-response.js';
import type { Advisory, QueueItem, ResponseStatus } from '../shared/types.js';

const advisory = (id: string): Advisory => ({ id, aliases: [], summary: `${id} の問題`, severity: 'high', severitySource: 'test', cvss: null, fixed: '9.9.9', published: null, modified: null, references: [], detailsAvailable: true });
const item = (id: string, status: ResponseStatus): QueueItem => ({ projectId: 'p', advisory: advisory(id), dependencies: [], status, note: '', reviewBy: null, updatedAt: null, resolvedAt: null, priority: 'high' });

test('プロジェクトの対応状況は、いちばん手当ての遅れている脆弱性に合わせる', () => {
  const mixed = projectResponseSummary([item('A', 'not-applicable'), item('B', 'fixing'), item('C', 'investigating'), item('D', 'resolved')]);
  assert.equal(mixed.status, 'fixing');
  assert.deepEqual(mixed.counts, { open: 0, fixing: 1, investigating: 1, 'awaiting-recheck': 0, 'not-applicable': 1, resolved: 1 });
  assert.deepEqual(mixed.current.map(i => i.advisory.id), ['A', 'B', 'C'], 'not-applicable is still current');
  assert.equal(mixed.total, 4);
  assert.equal(projectResponseSummary([item('A', 'fixing'), item('B', 'open')]).status, 'open');
  assert.equal(projectResponseSummary([item('A', 'awaiting-recheck'), item('B', 'investigating')]).status, 'investigating');
  assert.equal(projectResponseSummary([item('A', 'awaiting-recheck'), item('B', 'not-applicable')]).status, 'awaiting-recheck');
  // Exceptions only, or exceptions and resolved: not-applicable, not resolved.
  assert.equal(projectResponseSummary([item('A', 'not-applicable'), item('B', 'resolved')]).status, 'not-applicable');
});

test('すべて解消なら解消、0件は解消扱いにしない。部分的・古い照会では要確認', () => {
  const resolved = projectResponseSummary([item('A', 'resolved'), item('B', 'resolved')], { status: 'complete', stale: false });
  assert.equal(resolved.status, 'resolved'); assert.deepEqual(resolved.current, []); assert.equal(resolved.total, 2);
  const empty = projectResponseSummary([]);
  assert.equal(empty.status, 'none'); assert.equal(empty.total, 0);
  assert.equal(projectResponseSummary([], { status: 'complete' }).status, 'none');
  assert.equal(projectResponseSummary([], { status: 'partial' }).status, 'review', 'a partial check may have missed advisories');
  assert.equal(projectResponseSummary([item('A', 'resolved')], { stale: true }).status, 'review');
  assert.equal(projectResponseSummary([item('A', 'not-applicable')], { status: 'partial' }).status, 'review');
  // Something still open stays open, however partial the check.
  assert.equal(projectResponseSummary([item('A', 'open')], { status: 'partial', stale: true }).status, 'open');
});

test('同じアドバイザリIDは1件として数える', () => {
  const summary = projectResponseSummary([item('A', 'open'), item('A', 'open'), item('B', 'resolved')]);
  assert.equal(summary.total, 2); assert.equal(summary.counts.open, 1); assert.equal(summary.current.length, 1);
});

test('プロジェクト単位の対応状況：今の脆弱性すべてを1回で更新し、各メモと他プロジェクトは変えない', async () => {
  const store = new Store(':memory:');
  try {
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const [app] = store.import('app', [{ ...base, id: 'app', name: 'app', path: '/x/app' }]).projectIds;
    const [other] = store.import('other', [{ ...base, id: 'other', name: 'other', fingerprint: 'other', path: '/x/other' }]).projectIds;
    const dependency = (name: string) => ({ ecosystem: 'npm' as const, name, version: '1.0.0', requested: null, direct: true, scope: 'prod' as const, source: 'registry' as const, file: 'package-lock.json', component: '' });
    const save = (projectId: string, ids: string[]) => store.saveVulnerabilityCheck({ projectId, checkedAt: '2026-10-26T00:00:00Z', snapshotReadAt: '', status: 'complete', queried: ids.length, failed: 0, notSent: {},
      findings: ids.map(id => ({ dependency: dependency(id.toLowerCase()), advisories: [advisory(id)] })) });
    save(app, ['GHSA-A', 'GHSA-B']); save(other, ['GHSA-A']);
    const api = createApi(store, 4310);
    const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'content-type': 'application/json' };
    const { token } = await (await api.request('http://127.0.0.1:4310/api/session', { headers })).json() as any;
    const call = async (projectId: string, body: unknown) => {
      const response = await api.request(`http://127.0.0.1:4310/api/projects/${projectId}/response`, { method: 'POST', headers: { ...headers, 'x-owndapp-token': token }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    const record = (projectId: string, id: string) => store.responses(projectId).find(r => r.advisoryId === id);
    store.setResponses([{ projectId: app, advisory: { id: 'GHSA-A', summary: '', severity: 'high', fixed: null, package: 'ghsa-a', version: '1.0.0' } }], 'investigating', 'Aは本番で未使用か確認');
    store.setResponses([{ projectId: app, advisory: { id: 'GHSA-B', summary: '', severity: 'high', fixed: null, package: 'ghsa-b', version: '1.0.0' } }], 'investigating', 'Bは更新でAPIが変わる');
    store.setResponses([{ projectId: other, advisory: { id: 'GHSA-A', summary: '', severity: 'high', fixed: null, package: 'ghsa-a', version: '1.0.0' } }], 'investigating', '別プロジェクト');
    const before = store.responses(other);

    // Both advisories at once; each keeps its own note, and history grows.
    assert.deepEqual(await call(app, { ids: ['GHSA-B', 'GHSA-A'], status: 'fixing' }), { status: 200, data: { updated: 2 } });
    assert.deepEqual([record(app, 'GHSA-A')!.status, record(app, 'GHSA-B')!.status], ['fixing', 'fixing']);
    assert.equal(record(app, 'GHSA-A')!.note, 'Aは本番で未使用か確認');
    assert.equal(record(app, 'GHSA-B')!.note, 'Bは更新でAPIが変わる');
    assert.deepEqual(record(app, 'GHSA-A')!.history.map(h => h.status), ['investigating', 'fixing']);
    // A note given with another status does not replace the per-advisory notes.
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'awaiting-recheck', note: '一括で更新した' })).data.updated, 2);
    assert.equal(record(app, 'GHSA-B')!.note, 'Bは更新でAPIが変わる');
    assert.equal(record(app, 'GHSA-B')!.history.at(-1)!.note, '一括で更新した');
    // Repeated ids are normalized; they still have to cover everything found now.
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-A', 'GHSA-B'], status: 'investigating' })).data.updated, 2);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-A'], status: 'fixing' })).status, 409);
    assert.equal(record(app, 'GHSA-A')!.status, 'investigating');

    // Not applicable needs one shared reason, which becomes every advisory's note with the review date.
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'not-applicable' })).status, 400);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'not-applicable', note: '  ' })).status, 400);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'not-applicable', note: '社内検証環境のみ', reviewBy: '2027-01' })).status, 400);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'not-applicable', note: '社内検証環境のみ', reviewBy: '2027-01-31' })).data.updated, 2);
    for (const id of ['GHSA-A', 'GHSA-B']) assert.deepEqual([record(app, id)!.status, record(app, id)!.note, record(app, id)!.reviewBy], ['not-applicable', '社内検証環境のみ', '2027-01-31']);
    // reviewBy belongs to not-applicable only.
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'fixing', reviewBy: '2027-01-31' })).data.updated, 2);
    assert.equal(record(app, 'GHSA-A')!.reviewBy, null);

    // Resolved is never set by hand; bad bodies and unknown projects are refused.
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'resolved' })).status, 400);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'done' })).status, 400);
    assert.equal((await call(app, { ids: [], status: 'fixing' })).status, 400);
    assert.equal((await call(app, { ids: 'GHSA-A', status: 'fixing' })).status, 400);
    assert.equal((await call(app, { ids: [1], status: 'fixing' })).status, 400);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'fixing', note: 3 })).status, 400);
    assert.equal((await call('missing', { ids: ['GHSA-A'], status: 'fixing' })).status, 404);

    // A recheck changed the advisories: the old list is refused and nothing is written.
    save(app, ['GHSA-A', 'GHSA-B', 'GHSA-C']);
    const snapshot = store.responses(app);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B'], status: 'investigating' })).status, 409);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B', 'GHSA-C', 'GHSA-OLD'], status: 'investigating' })).status, 409);
    assert.deepEqual(store.responses(app), snapshot, 'no partial update');
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B', 'GHSA-C'], status: 'investigating' })).data.updated, 3);
    assert.equal(record(app, 'GHSA-C')!.note, '');

    // An advisory no longer found (resolved by a recheck) is not part of the current set.
    save(app, ['GHSA-A']);
    assert.equal((await call(app, { ids: ['GHSA-A', 'GHSA-B', 'GHSA-C'], status: 'fixing' })).status, 409);
    assert.equal((await call(app, { ids: ['GHSA-A'], status: 'fixing' })).data.updated, 1);
    assert.equal(record(app, 'GHSA-B')!.status, 'investigating', 'not in the current check, so left alone');

    assert.deepEqual(store.responses(other), before, 'other project untouched');
  } finally { store.close(); }
});
