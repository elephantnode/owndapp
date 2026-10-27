import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';

test('Windowsで対応exeを登録し、登録済みのアプリだけへプロジェクトを渡す', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'owndapp-apps-')));
  const store = new Store(':memory:'); let choice: string | null = null;
  const opened: unknown[][] = [];
  const api = createApi(store, 4310, async () => null, async () => {}, { platform: 'win32', pickApp: async () => choice, openApp: async (...args) => { opened.push(args); } });
  try {
    const projectPath = join(base, 'project & value'); await mkdir(projectPath);
    const [id] = store.import('apps', [{ id: 'apps', name: 'example', path: projectPath, technologies: [], components: [], evidence: [], fingerprint: 'apps', registered: false }]).projectIds;
    const editor = join(base, 'Code.exe'); const terminal = join(base, 'cmd.exe'); const unsupported = join(base, 'node.exe');
    for (const path of [editor, terminal, unsupported]) await writeFile(path, 'fixture; never executed');
    const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'content-type': 'application/json', 'x-owndapp-token': '' };
    const call = async (path: string, body?: unknown) => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    headers['x-owndapp-token'] = (await call('/session')).data.token;
    choice = editor; assert.equal((await call('/apps/pick', { role: 'editor' })).status, 200);
    choice = terminal; assert.equal((await call('/apps/pick', { role: 'terminal' })).status, 200);
    assert.equal((await call('/apps')).data.apps.editor.name, 'Code');
    choice = null; assert.equal((await call('/apps/pick', { role: 'editor' })).data.cancelled, true);
    choice = unsupported; assert.equal((await call('/apps/pick', { role: 'editor' })).status, 400);
    assert.equal((await call('/apps')).data.apps.editor.path, editor);
    assert.equal((await call(`/projects/${id}/open`, { role: 'editor', app: unsupported })).status, 200);
    assert.equal((await call(`/projects/${id}/open`, { role: 'terminal' })).status, 200);
    assert.deepEqual(opened, [[editor, projectPath, 'editor'], [terminal, projectPath, 'terminal']]);
    await rm(editor);
    assert.equal((await call(`/projects/${id}/open`, { role: 'editor' })).status, 404);
    assert.equal(opened.length, 2);
  } finally { await api.shutdownScans(); store.close(); await rm(base, { recursive: true, force: true }); }
});
