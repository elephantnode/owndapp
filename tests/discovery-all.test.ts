import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import type { Scan } from '../shared/types.js';

async function fixture(fn: (root: string, put: (file: string, data: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-all-'));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  try { await fn(await canonicalRoot(root), put); } finally { await rm(root, { recursive: true, force: true }); }
}

function client(store: Store) {
  const api = createApi(store, 4310);
  let token = '';
  const call = async (path: string, body?: unknown) => {
    const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    if (path === '/session' && data.token) token = data.token;
    return { response, data };
  };
  return { api, call };
}

const settle = async (call: ReturnType<typeof client>['call'], id: string) => {
  let scan: Scan = (await call(`/scans/${id}`)).data.scan;
  for (let attempt = 0; attempt < 200 && scan.status === 'running'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${id}`)).data.scan; }
  return scan;
};

test('登録したフォルダをすべて順に探索し、候補を1つの一覧で選んで登録できる', async () => {
  await fixture(async (root, put) => {
    const app = (name: string) => JSON.stringify({ name, dependencies: { vue: '^3.5' } });
    await put('one/app1/package.json', app('app1'));
    await put('one/inner/app3/package.json', app('app3'));
    await put('two/app2/package.json', app('app2'));
    const store = new Store(':memory:');
    const { api, call } = client(store);
    try {
      await call('/session');
      // Three folders, one nested in another, each scanned once when added.
      for (const folder of ['one', 'two', 'one/inner']) {
        const started = await call('/scans', { root: join(root, folder) });
        assert.equal((await settle(call, started.data.scan.id)).status, 'completed');
      }
      await put('two/app4/package.json', app('app4'));

      const swept = await call('/scans/sweep', {});
      assert.equal(swept.response.status, 202);
      assert.deepEqual(swept.data.sweep.roots, ['one', 'two', 'one/inner'].map(folder => join(root, folder)));
      assert.equal((await call('/scans', { root: join(root, 'two') })).response.status, 409, 'no other scan while every folder is scanned');
      let sweep = swept.data.sweep;
      for (let attempt = 0; attempt < 300 && sweep.status === 'running'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); sweep = (await call('/scans/sweep')).data.sweep; }
      assert.equal(sweep.status, 'completed'); assert.equal(sweep.done, 3);

      // app3 is found by both "one" and "one/inner" but listed once; app4 appeared after the first scans.
      const listed = await call('/candidates?filter=new&limit=30');
      assert.deepEqual(listed.data.folders, { total: 3, scanned: 3 });
      assert.deepEqual(listed.data.candidates.map((c: { name: string }) => c.name).sort(), ['app1', 'app2', 'app3', 'app4']);
      assert.equal(listed.data.filteredCount, 4);
      assert.deepEqual((await call('/candidates?filter=new&q=APP2')).data.candidates.map((c: { name: string }) => c.name), ['app2']);
      const { ids } = (await call('/candidates/selection?filter=new')).data;
      assert.equal(ids.length, 4);

      // Candidates from different folders' scans are registered together, without naming a scan.
      const added = await call('/imports', { id: 'all-folders', candidateIds: ids });
      assert.equal(added.response.status, 201); assert.equal(added.data.projectIds.length, 4);
      assert.equal((await call('/candidates?filter=new')).data.filteredCount, 0);
      assert.equal((await call('/candidates?filter=registered')).data.filteredCount, 4);
      assert.equal((await call('/imports', { id: 'unknown', candidateIds: ['missing'] })).response.status, 400);
    } finally { await api.shutdownScans(); store.close(); }
  });
});

test('すべて探索は、見つからなくなったフォルダを飛ばして残りを探索する', async () => {
  await fixture(async (root, put) => {
    for (const folder of ['a', 'b']) await put(`${folder}/app/package.json`, '{"name":"app"}');
    const store = new Store(':memory:');
    const { api, call } = client(store);
    try {
      await call('/session');
      assert.equal((await call('/scans/sweep', {})).response.status, 400, 'nothing to scan before a folder is added');
      for (const folder of ['a', 'b']) await settle(call, (await call('/scans', { root: join(root, folder) })).data.scan.id);
      await rm(join(root, 'a'), { recursive: true, force: true });
      let sweep = (await call('/scans/sweep', {})).data.sweep;
      for (let attempt = 0; attempt < 300 && sweep.status === 'running'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); sweep = (await call('/scans/sweep')).data.sweep; }
      assert.equal(sweep.status, 'completed');
      assert.deepEqual(sweep.skipped, [join(root, 'a')]);
      assert.equal((await call(`/scans/${sweep.scanId}`)).data.scan.root, join(root, 'b'));
    } finally { await api.shutdownScans(); store.close(); }
  });
});
