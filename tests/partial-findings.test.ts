import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { check } from '../server/vulnerabilities.js';
import type { OsvClient, OsvRecord } from '../server/osv.js';
import type { Dependency } from '../shared/types.js';

const dep = (name: string, version: string, extra: Partial<Dependency> = {}): Dependency =>
  ({ ecosystem: 'npm', name, version, requested: null, direct: false, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '', ...extra });
const advisory = (id: string, name: string, extra: Partial<OsvRecord> = {}): OsvRecord => ({
  id, summary: `${id} の問題`, aliases: [], database_specific: { severity: 'HIGH' },
  affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.0.0' }] }] }], ...extra,
});

// Answers from fixed ids per package and fixed records; failing packages and failing details are configurable per run.
function fakeClient(state: { ids: Record<string, string[]>; records: OsvRecord[]; failPackages?: string[]; failDetails?: string[] }): OsvClient {
  return {
    async queryBatch(queries) {
      if (queries.some(q => state.failPackages?.includes(q.name))) throw new Error('offline');
      return queries.map(q => ({ ids: state.ids[q.name] || [] }));
    },
    async vulnerability(id) {
      if (state.failDetails?.includes(id)) throw new Error('offline');
      const record = state.records.find(r => r.id === id); if (!record) throw new Error('not found'); return record;
    },
  };
}

function setup(dependencies: Dependency[]) {
  const store = new Store(':memory:');
  const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
  const { projectIds: [id] } = store.import('partial', [{ ...base, id: 'app', name: 'app', path: '/nonexistent/owndapp-test/app' }]);
  store.saveDependencies({ projectId: id, readAt: '2026-10-01T00:00:00.000Z', status: 'complete', total: dependencies.length, direct: dependencies.filter(d => d.direct).length,
    files: [{ path: 'package-lock.json', lockfileVersion: 3, status: 'ok', message: '', hashes: {} }] }, dependencies);
  return { store, id };
}
const run = (store: Store, id: string, client: OsvClient) => check(store, client, [id], { retries: 0 });

test('一部のバッチだけ照会に失敗したとき、答えのあった新しい検出と、失敗した側の前回の検出を残す', async () => {
  // Batches hold 500 package versions, so "b" is queried in a second batch that can fail alone.
  const fillers = Array.from({ length: 499 }, (_, i) => dep(`a-filler-${i}`, '1.0.0'));
  const { store, id } = setup([dep('a', '1.0.0'), ...fillers, dep('b', '1.0.0')]);
  try {
    const records = [advisory('GHSA-a', 'a'), advisory('GHSA-b', 'b'), advisory('GHSA-a2', 'a')];
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'], b: ['GHSA-b'] }, records }));
    const first = store.vulnerabilityCheck(id)!;
    const result = await run(store, id, fakeClient({ ids: { a: ['GHSA-a2'], b: [] }, records, failPackages: ['b'] }));
    assert.deepEqual(result.results.map(r => [r.status, r.count]), [['partial', 3]]);
    const saved = store.vulnerabilityCheck(id)! as any;
    assert.deepEqual([saved.status, saved.queried, saved.failed], ['partial', 500, 1]);
    const ids = (retained: boolean) => saved.findings.filter((f: any) => !!f.retained === retained).flatMap((f: any) => f.advisories.map((a: any) => a.id)).sort();
    assert.deepEqual(ids(false), ['GHSA-a2'], 'new positive from the answered batch');
    // GHSA-b was not answered and GHSA-a was answered as gone, but only a complete check may clear either.
    assert.deepEqual(ids(true), ['GHSA-a', 'GHSA-b']);
    assert.ok(saved.findings.filter((f: any) => f.retained).every((f: any) => f.observedAt === first.checkedAt));
  } finally { store.close(); }
});

test('照会の一部が失敗しても、新しい検出と消せない前回の検出を残し、解消扱いにしない', async () => {
  const { store, id } = setup([dep('a', '1.0.0', { direct: true }), dep('b', '1.0.0')]);
  try {
    const state = { ids: { a: ['GHSA-a'], b: ['GHSA-b'] } as Record<string, string[]>, records: [advisory('GHSA-a', 'a'), advisory('GHSA-b', 'b'), advisory('GHSA-new', 'a')] };
    await run(store, id, fakeClient(state));
    const first = store.vulnerabilityCheck(id)!;
    assert.equal(first.status, 'complete');
    store.setResponses([{ projectId: id, advisory: { id: 'GHSA-b', summary: '', severity: 'high', fixed: '9.0.0', package: 'b', version: '1.0.0' } }], 'investigating');

    // All queries fail: preserve the earlier observations, but record the failed attempt as partial.
    const offline = await run(store, id, fakeClient({ ...state, failPackages: ['a', 'b'] }));
    assert.deepEqual(offline.results.map(r => r.status), ['partial']);
    const failedAttempt = store.vulnerabilityCheck(id)!;
    assert.equal(failedAttempt.status, 'partial');
    assert.equal(failedAttempt.checkedAt, first.checkedAt);
    assert.ok(failedAttempt.attemptedAt);
    assert.ok(failedAttempt.findings.every(f => f.retained && f.observedAt === first.checkedAt));
    assert.deepEqual(failedAttempt.findings.map(f => f.advisories), first.findings.map(f => f.advisories));

    // Details of the new advisory cannot be fetched and GHSA-b is no longer listed: partial, so nothing is cleared.
    state.ids = { a: ['GHSA-a', 'GHSA-new'], b: [] };
    const partial = await run(store, id, fakeClient({ ...state, failDetails: ['GHSA-new'] }));
    assert.deepEqual(partial.results.map(r => [r.status, r.count]), [['partial', 3]]);
    const saved = store.vulnerabilityCheck(id)! as any;
    assert.equal(saved.status, 'partial'); assert.equal(saved.detailsFailed, 1); assert.equal(saved.attemptedAt, saved.checkedAt);
    const fresh = saved.findings.find((f: any) => !f.retained);
    assert.deepEqual(fresh.advisories.map((a: any) => [a.id, a.detailsAvailable]), [['GHSA-a', true], ['GHSA-new', false]], 'a new positive is kept even without details');
    assert.equal(fresh.observedAt, saved.checkedAt);
    const retained = saved.findings.find((f: any) => f.retained);
    assert.deepEqual(retained.advisories.map((a: any) => a.id), ['GHSA-b']);
    assert.equal(retained.observedAt, first.checkedAt, 'retained findings keep when they were last observed');
    assert.equal(store.responses(id).find(r => r.advisoryId === 'GHSA-b')!.status, 'investigating', 'a partial check resolves nothing');

    // A complete check alone clears and resolves.
    await run(store, id, fakeClient(state));
    const complete = store.vulnerabilityCheck(id)! as any;
    assert.equal(complete.status, 'complete'); assert.equal(complete.detailsFailed, 0);
    assert.deepEqual(complete.findings.flatMap((f: any) => f.advisories.map((a: any) => a.id)).sort(), ['GHSA-a', 'GHSA-new']);
    assert.ok(complete.findings.every((f: any) => !f.retained));
    assert.equal(store.responses(id).find(r => r.advisoryId === 'GHSA-b')!.status, 'resolved');
  } finally { store.close(); }
});

test('詳細が取れないときは前回の重大度を残し、保持したことを示す', async () => {
  const { store, id } = setup([dep('a', '1.0.0')]);
  try {
    const records = [advisory('GHSA-a', 'a', { database_specific: { severity: 'CRITICAL' } })];
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'] }, records }));
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'] }, records, failDetails: ['GHSA-a'] }));
    const saved = store.vulnerabilityCheck(id)!;
    assert.equal(saved.status, 'partial');
    const a = saved.findings[0].advisories[0] as any;
    assert.deepEqual([a.id, a.severity, a.severityRetained, a.detailsAvailable, a.fixed, a.summary], ['GHSA-a', 'critical', true, false, '9.0.0', 'GHSA-a の問題']);
    assert.match(a.severityReason, /前回の重大度/);
    // Fresh details replace the retained severity, even when lower.
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'] }, records: [advisory('GHSA-a', 'a', { database_specific: { severity: 'LOW' } })] }));
    const next = store.vulnerabilityCheck(id)!.findings[0].advisories[0] as any;
    assert.equal(next.severity, 'low'); assert.equal(next.severityRetained, undefined);
  } finally { store.close(); }
});

test('別名のまとまりで代表IDが変わっても、前回のIDと対応記録を引き継ぐ', async () => {
  const { store, id } = setup([dep('a', '1.0.0')]);
  try {
    // First seen only under its CVE id.
    await run(store, id, fakeClient({ ids: { a: ['CVE-2026-7'] }, records: [advisory('CVE-2026-7', 'a')] }));
    store.setResponses([{ projectId: id, advisory: { id: 'CVE-2026-7', summary: '', severity: 'high', fixed: null, package: 'a', version: '1.0.0' } }], 'fixing');
    // Now GHSA, which would be canonical, reports it too.
    const records = [advisory('CVE-2026-7', 'a'), advisory('GHSA-7', 'a', { aliases: ['CVE-2026-7'], database_specific: { severity: 'CRITICAL' } })];
    await run(store, id, fakeClient({ ids: { a: ['GHSA-7', 'CVE-2026-7'] }, records }));
    const saved = store.vulnerabilityCheck(id)!;
    assert.equal(saved.status, 'complete');
    assert.deepEqual(saved.findings[0].advisories.map(a => [a.id, a.aliases, a.severity]), [['CVE-2026-7', ['GHSA-7'], 'critical']]);
    const response = store.responses(id).find(r => r.advisoryId === 'CVE-2026-7')!;
    assert.equal(response.status, 'fixing', 'the response is not resolved by the id change');
    assert.equal(store.responses(id).length, 1);
  } finally { store.close(); }
});

test('同じ版が本番と開発の両方にあるときは本番扱い、どれかが直接なら直接とする', async () => {
  const { store, id } = setup([dep('a', '1.0.0', { scope: 'dev', direct: true, component: 'tools' }), dep('a', '1.0.0', { scope: 'prod' }),
    dep('b', '1.0.0', { scope: 'dev' }), dep('b', '1.0.0', { scope: 'dev', component: 'tools' }), dep('c', '1.0.0', { scope: 'dev' }), dep('c', '1.0.0', { scope: 'unknown' })]);
  try {
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'], b: ['GHSA-b'], c: ['GHSA-c'] }, records: [advisory('GHSA-a', 'a'), advisory('GHSA-b', 'b'), advisory('GHSA-c', 'c')] }));
    const findings = store.vulnerabilityCheck(id)!.findings;
    assert.equal(findings.length, 3, 'one finding per package version');
    const of = (name: string) => findings.find(f => f.dependency.name === name)!.dependency;
    assert.deepEqual([of('a').scope, of('a').direct], ['prod', true]);
    assert.deepEqual([of('b').scope, of('b').direct], ['dev', false]);
    assert.equal(of('c').scope, 'unknown');
  } finally { store.close(); }
});

test('前回の強い重大度を保持するとき、CVSS値とベクトルの組を混ぜない', async () => {
  const { store, id } = setup([dep('a', '1.0.0')]);
  const highVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const lowerVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H';
  try {
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a'] }, records: [advisory('GHSA-a', 'a', { database_specific: { severity: 'CRITICAL' }, severity: [{ type: 'CVSS_V3', score: highVector }] })] }));
    await run(store, id, fakeClient({ ids: { a: ['GHSA-a', 'CVE-a'] }, records: [advisory('GHSA-a', 'a', { aliases: ['CVE-a'], severity: [{ type: 'CVSS_V3', score: lowerVector }] })], failDetails: ['CVE-a'] }));
    const retained = store.vulnerabilityCheck(id)!.findings[0].advisories[0];
    assert.equal(retained.severity, 'critical');
    assert.equal(retained.severityRetained, true);
    assert.equal(retained.severityScore, 9.8);
    assert.equal(retained.cvss, highVector);
    assert.ok(retained.severityEvidence!.some(e => e.cvss === lowerVector));
  } finally { store.close(); }
});
