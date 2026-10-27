import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { absoluteFolder, folderInput, pathWithin } from '../server/paths.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import { canonicalRoot } from '../server/scanner.js';

const windows = 'win32';
test('Windowsの絶対パスはドライブ/UNCのみ、引用符とホームを展開する', () => {
  for (const path of [String.raw`C:\Users\名前\Projects`, 'D:/apps/test', String.raw`\\nas\share\apps`, '//nas/share']) assert.equal(absoluteFolder(path, windows), true, path);
  for (const path of ['C:relative', String.raw`\relative`, '/relative', 'apps', String.raw`\\nas`, String.raw`\\?\C:\apps`, '//./pipe/test']) assert.equal(absoluteFolder(path, windows), false, path);
  assert.equal(folderInput('"C:\\Users\\名前\\My Apps"', windows), String.raw`C:\Users\名前\My Apps`);
  assert.equal(folderInput(String.raw`~\Projects`, windows, String.raw`C:\Users\名前`), String.raw`C:\Users\名前\Projects`);
  assert.equal(folderInput('~/Projects', windows, String.raw`C:\Users\名前`), String.raw`C:\Users\名前\Projects`);
  assert.equal(folderInput('~', windows, String.raw`C:\Users\名前`), String.raw`C:\Users\名前`);
  assert.throws(() => folderInput('C:relative', windows));
  assert.equal(folderInput('/tmp/project', 'darwin'), '/tmp/project');
  assert.equal(folderInput('/tmp/with\\name', 'darwin'), '/tmp/with\\name');
});

test('Windowsの範囲判定は別ドライブ・共有・同名前置詞・親へ出るパスを拒否する', () => {
  const root = String.raw`C:\Projects`;
  for (const path of [root, 'c:/projects/app', String.raw`C:\Projects\app\..\api`]) assert.equal(pathWithin(root, path, windows), true, path);
  for (const path of ['D:/Projects/app', 'C:/Projects-other/app', 'C:/Projects/../secret']) assert.equal(pathWithin(root, path, windows), false, path);
  assert.equal(pathWithin(String.raw`\\nas\share`, '//NAS/share/app', windows), true);
  assert.equal(pathWithin(String.raw`\\nas\share`, '//nas/share-other/app', windows), false);
  assert.equal(pathWithin('/Projects', '/projects/app', 'darwin'), false);
});

test('機能情報はサーバーOSに基づき、未対応のネイティブ操作は実行しない', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const store = new Store(':memory:'); let calls = 0;
    const api = createApi(store, 4310, async () => { calls++; return null; }, async () => { calls++; }, { platform, pickApp: async () => { calls++; return null; }, openApp: async () => { calls++; } });
    try {
      const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'content-type': 'application/json', 'x-owndapp-token': '' };
      const call = (path: string, body?: unknown) => api.request(`http://127.0.0.1:4310/api${path}`, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      const session = await (await call('/session')).json(); headers['x-owndapp-token'] = session.token;
      assert.deepEqual(session.capabilities, { platform, folderPicker: true, revealFolder: platform === 'darwin', externalApps: true });
      if (platform === 'win32') {
        const response = await call('/projects/unregistered/reveal', {}); assert.equal(response.status, 501); assert.equal(calls, 0);
        assert.equal((await call('/apps/pick', { role: 'editor' })).status, 200); assert.equal(calls, 1);
        assert.equal((await call('/folder-picker', {})).status, 200); assert.equal(calls, 2);
      } else { assert.equal((await call('/folder-picker', {})).status, 200); assert.equal(calls, 1); }
    } finally { await api.shutdownScans(); store.close(); }
  }
});

test('ネイティブ操作なしの能力構成でも、パス入力から探索・登録・依存読み取りが完了する', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-platform-'));
  const store = new Store(':memory:');
  const api = createApi(store, 4310, undefined, undefined, { platform: 'win32' });
  try {
    const root = await canonicalRoot(base); const app = join(root, '日本語 app'); await mkdir(app);
    await writeFile(join(app, 'package.json'), '{"name":"path-only-app"}');
    await writeFile(join(app, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{},"node_modules/example":{"version":"1.0.0","resolved":"https://registry.npmjs.org/example/-/example-1.0.0.tgz"}}}');
    const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'content-type': 'application/json', 'x-owndapp-token': '' };
    const call = async (path: string, body?: unknown) => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
    };
    headers['x-owndapp-token'] = (await call('/session')).token;
    let { scan } = await call('/scans', { root });
    for (let i = 0; i < 100 && scan.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).scan; }
    assert.equal(scan.status, 'completed'); assert.equal(scan.candidates.length, 1);
    const imported = await call('/imports', { id: 'path-only', scanId: scan.id, candidateIds: [scan.candidates[0].id] });
    const results = await call('/dependencies/read', { ids: imported.projectIds }); assert.equal(results.results[0].status, 'complete');
    const search = await call('/dependencies/search?name=example'); assert.equal(search.matches[0].project.name, 'path-only-app');
    const exclusion = await call('/exclusions', { paths: [app] }); assert.equal(exclusion.registeredInside, 1);
  } finally { await api.shutdownScans(); store.close(); await rm(base, { recursive: true, force: true }); }
});
