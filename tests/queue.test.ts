import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { fixtureClient, type OsvClient, type OsvRecord } from '../server/osv.js';
import { priorityOf } from '../shared/priority.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import type { QueueItem } from '../shared/types.js';

test('優先度は重大度を下限にし、公開状況や開発状態だけでは下げない', () => {
  assert.equal(priorityOf('critical', 'public', 'maintained'), 'high');
  assert.equal(priorityOf('high', undefined, 'untriaged'), 'high', 'unknown exposure counts as public');
  assert.equal(priorityOf('critical', 'internal', 'maintained'), 'high');
  assert.equal(priorityOf('moderate', 'public', 'active'), 'medium');
  assert.equal(priorityOf('critical', 'local', 'active'), 'high');
  for (const lifecycle of ['completed', 'cancelled', 'archived'] as const) {
    assert.equal(priorityOf('critical', 'public', lifecycle), 'high', `${lifecycle} does not prove a public deployment stopped`);
    assert.equal(priorityOf('high', undefined, lifecycle), 'high', 'unknown exposure remains conservative');
  }
  assert.equal(priorityOf('malicious', 'unknown', 'on_hold'), 'high');
  assert.equal(priorityOf('unknown', 'local', 'active'), 'review');
  assert.equal(priorityOf('moderate', 'local', 'active'), 'medium');
  assert.equal(priorityOf('low', 'public', 'maintained'), 'low');
});

test('悪意のある依存はローカルでも開発状態にかかわらず高優先度', () => {
  for (const exposure of ['public', 'internal', 'local', 'unknown'] as const) {
    for (const lifecycle of ['untriaged', 'active', 'maintained', 'completed', 'cancelled', 'archived'] as const) {
      assert.equal(priorityOf('malicious', exposure, lifecycle), 'high');
    }
  }
});

const advisory = (id: string, name: string, fixed: string, severity = 'HIGH'): OsvRecord => ({ id, summary: `${name} の問題`,
  affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }], database_specific: { severity } });
const lock = (deps: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: deps },
  ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])) } });

test('対応キュー：状態を記録し、再照会で消えたら自動で解消、再び出たら未対応に戻す', async () => {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-queue-')));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  const store = new Store(':memory:');
  try {
    await put('app/package.json', JSON.stringify({ dependencies: { lodash: '4.17.15', minimist: '1.2.0' } }));
    await put('app/package-lock.json', lock({ lodash: '4.17.15', minimist: '1.2.0' }));
    let client: OsvClient = fixtureClient({ 'lodash@4.17.15': [advisory('GHSA-lodash', 'lodash', '4.17.21', 'CRITICAL')], 'minimist@1.2.0': [advisory('GHSA-mini', 'minimist', '1.2.6', 'LOW')] });
    const api = createApi(store, 4310, undefined, undefined, { osv: { queryBatch: q => client.queryBatch(q), vulnerability: id => client.vulnerability(id) }, osvOptions: { wait: async () => {} } });
    let token = '';
    const call = async (path: string, body?: unknown) => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as any; if (path === '/session') token = data.token; return { response, data };
    };
    const check = async (ids: string[]) => {
      let job = (await call('/vulnerabilities/check', { ids })).data.job;
      for (let i = 0; i < 500 && job.status === 'running'; i++) { await new Promise(r => setTimeout(r, 2)); job = (await call('/vulnerabilities/job')).data.job; }
      return job;
    };
    await call('/session');
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const { projectIds: [app] } = store.import('q', [{ ...base, id: 'app', name: 'app', path: join(root, 'app') }]);
    await check([app]);
    const items = async (): Promise<QueueItem[]> => { const d = (await call('/queue')).data; return d.items.map((i: any) => ({ ...i, advisory: d.advisories[i.advisoryKey ?? i.advisoryId] })); };
    let list = await items();
    assert.deepEqual(list.map(i => [i.advisory.id, i.status, i.priority]).sort(), [['GHSA-lodash', 'open', 'high'], ['GHSA-mini', 'open', 'low']]);
    // One project only, for the detail page's fix memo.
    assert.deepEqual(Object.keys((await call(`/queue?project=${app}`)).data.projects), [app]);
    assert.equal((await call(`/queue?project=${app}`)).data.items.length, 2);
    assert.equal((await call('/queue?project=other')).data.items.length, 0);
    // Exposure changes ordering; development completion must not hide public risk.
    await call('/projects/exposure', { ids: [app], exposure: 'local' });
    assert.equal((await items()).find(i => i.advisory.id === 'GHSA-lodash')!.priority, 'high');
    assert.equal((await items()).find(i => i.advisory.id === 'GHSA-mini')!.priority, 'low');
    await call('/projects/exposure', { ids: [app], exposure: 'public' });
    for (const lifecycle of ['completed', 'cancelled'] as const) {
      await call('/projects/lifecycle', { ids: [app], lifecycle });
      assert.equal((await items()).find(i => i.advisory.id === 'GHSA-lodash')!.priority, 'high');
    }
    await call('/projects/lifecycle', { ids: [app], lifecycle: 'maintained' });
    // Status by hand: resolved is not allowed, not-applicable needs a reason.
    const key = (id: string) => ({ projectId: app, advisoryId: id });
    assert.equal((await call('/queue/status', { items: [key('GHSA-lodash')], status: 'resolved' })).response.status, 400);
    assert.equal((await call('/queue/status', { items: [key('GHSA-mini')], status: 'not-applicable' })).response.status, 400);
    assert.equal((await call('/queue/status', { items: [key('GHSA-unknown')], status: 'investigating' })).response.status, 409);
    assert.equal((await call('/queue/status', { items: [key('GHSA-lodash')], status: 'awaiting-recheck', note: '4.17.21 に更新' })).data.updated, 1);
    assert.equal((await call('/queue/status', { items: [key('GHSA-mini')], status: 'not-applicable', note: '開発時のみ使用', reviewBy: '2027-01-31' })).data.updated, 1);
    list = await items();
    assert.equal(list.find(i => i.advisory.id === 'GHSA-lodash')!.status, 'awaiting-recheck');
    assert.equal(list.find(i => i.advisory.id === 'GHSA-mini')!.reviewBy, '2027-01-31');
    // Archived projects leave the queue list, but stay reachable for a detail-page memo.
    store.setLifecycle([app], 'archived', '公開終了');
    assert.equal((await items()).length, 0);
    assert.equal((await call(`/queue?project=${app}`)).data.items.length, 2);
    store.setLifecycle([app], 'maintained');
    assert.equal((await items()).length, 2);
    // The fix lands: a new lockfile, read and checked again. lodash is gone, so it is resolved by the check, not by hand.
    await put('app/package.json', JSON.stringify({ dependencies: { lodash: '4.17.21', minimist: '1.2.0' } }));
    await put('app/package-lock.json', lock({ lodash: '4.17.21', minimist: '1.2.0' }));
    await check([app]);
    list = await items();
    const lodash = list.find(i => i.advisory.id === 'GHSA-lodash')!;
    assert.equal(lodash.status, 'resolved'); assert.ok(lodash.resolvedAt);
    assert.equal(lodash.dependencies[0].version, '4.17.15', 'a resolved item keeps what it was');
    assert.equal(list.find(i => i.advisory.id === 'GHSA-mini')!.status, 'not-applicable', 'still found, so the decision stays');
    const history = store.responses(app).find(r => r.advisoryId === 'GHSA-lodash')!.history;
    assert.deepEqual(history.map(h => [h.status, h.by]), [['awaiting-recheck', 'user'], ['resolved', 'recheck']]);
    // It comes back: reopened as open, with its history.
    await put('app/package-lock.json', lock({ lodash: '4.17.15', minimist: '1.2.0' }));
    await check([app]);
    assert.equal((await items()).find(i => i.advisory.id === 'GHSA-lodash')!.status, 'open');
    // A failed check resolves nothing.
    await put('app/package-lock.json', lock({ minimist: '1.2.0' }));
    client = { async queryBatch() { throw new Error('offline'); }, async vulnerability() { throw new Error('offline'); } };
    await check([app]);
    assert.equal((await items()).find(i => i.advisory.id === 'GHSA-lodash')!.status, 'open');
    // An advisory never touched by hand is still recorded as resolved when it disappears.
    client = fixtureClient({ 'minimist@1.2.0': [advisory('GHSA-mini', 'minimist', '1.2.6', 'LOW')] });
    await check([app]);
    assert.equal((await items()).find(i => i.advisory.id === 'GHSA-lodash')!.status, 'resolved');
    // Removing the project keeps its responses in the removal record.
    store.remove([app], 'test');
    assert.equal(JSON.parse(store.removals()[0].payload).responses.length, 2);
    assert.deepEqual(store.responses(), []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('1件も照会していない古い照会結果は、未照会として扱う', () => {
  const store = new Store(':memory:');
  try {
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const { projectIds: [id] } = store.import('empty-check', [{ ...base, id: 'p', name: 'p', path: '/x/p' }]);
    // Earlier versions stored this for projects without a lockfile.
    store.saveVulnerabilityCheck({ projectId: id, checkedAt: '2026-10-20T00:00:00Z', snapshotReadAt: '2026-10-20T00:00:00Z', status: 'complete', queried: 0, failed: 0, notSent: {}, findings: [] });
    assert.equal(store.vulnerabilityCheck(id), null);
    assert.equal(store.vulnerabilityChecks().size, 0);
  } finally { store.close(); }
});

test('同じアドバイザリでもプロジェクトと影響版の情報を混ぜない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-queue-variants-'));
  const store = new Store(join(root, 'data'));
  try {
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const ids: string[] = [];
    for (const name of ['one', 'two']) {
      await mkdir(join(root, name));
      ids.push(store.import(`test-${name}`, [{ ...base, id: name, name, fingerprint: name, path: join(root, name) }]).projectIds[0]);
    }
    const dependency = (version: string) => ({ ecosystem: 'npm' as const, name: 'pkg', version, requested: null, direct: true, scope: 'prod' as const, source: 'registry' as const, file: 'package-lock.json', component: '' });
    const a = (severity: 'critical' | 'low', fixed: string) => ({ id: 'GHSA-shared', aliases: [], summary: '', severity, severitySource: 'test', cvss: null, fixed, published: null, modified: null, references: [], detailsAvailable: true });
    for (const [i, id] of ids.entries()) store.saveVulnerabilityCheck({ projectId: id, checkedAt: '2026-10-26T00:00:00Z', snapshotReadAt: '', status: 'complete', queried: 1, failed: 0, notSent: {}, findings: i === 0 ? [{ dependency: dependency('1.0.0'), advisories: [a('critical', '1.0.1')] }, { dependency: dependency('2.0.0'), advisories: [a('critical', '2.0.3')] }] : [{ dependency: dependency('3.0.0'), advisories: [a('low', '3.0.1')] }] });
    const api = createApi(store, 4310);
    const session = await (await api.request('http://127.0.0.1:4310/api/session', { headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web' } })).json() as any;
    const response = await api.request('http://127.0.0.1:4310/api/queue', { headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': session.token } });
    const wire = await response.json() as any;
    assert.equal(response.status, 200);
    const first = wire.items.find((i: any) => i.projectId === ids[0]);
    const second = wire.items.find((i: any) => i.projectId === ids[1]);
    assert.equal(wire.advisories[first.advisoryKey].severity, 'critical');
    assert.equal(wire.advisories[first.advisoryKey].fixed, null);
    assert.deepEqual(first.advisoryVariants.map((v: any) => v.advisory.fixed), ['1.0.1', '2.0.3']);
    assert.equal(wire.advisories[second.advisoryKey].severity, 'low');
    assert.equal(wire.advisories[second.advisoryKey].fixed, '3.0.1');
    assert.notEqual(first.advisoryKey, second.advisoryKey);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
