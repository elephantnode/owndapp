import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { inspectRuntime, supportedNode } from '../tools/doctor.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-doctor-'));
  const put = async (file, value) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), value); };
  try { await run(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}

test('対応Node版は最低版の直前・最低版・新しいメジャー・正式版かを区別', () => {
  assert.equal(supportedNode('24.13.9'), false);
  assert.equal(supportedNode('24.14.0'), true);
  assert.equal(supportedNode('25.0.0'), true);
  assert.equal(supportedNode('26.2.0'), true);
  assert.equal(supportedNode('24.14.0-rc.1'), false);
  assert.equal(supportedNode('unexpected'), false);
});

test('未導入・未ビルド・不正ポートを具体的に案内し、データやファイルを作成しない', async () => fixture(async (root, put) => {
  await put('package.json', JSON.stringify({ dependencies: { hono: '1' }, devDependencies: { tsx: '1' } }));
  const before = await readdir(root);
  const checks = await inspectRuntime({ root, nodeVersion: '24.14.0', platform: 'darwin', env: { OWNDAPP_PORT: 'not-a-port' } });
  const failures = checks.filter(c => !c.ok).map(c => c.message).join('\n');
  assert.match(failures, /npm ci --ignore-scripts/);
  assert.match(failures, /npm run build/);
  assert.match(failures, /OWNDAPP_PORT/);
  assert.deepEqual(await readdir(root), before);
}));

test('開発起動はdist不要、通常起動は必要。データ保存先の指定も保持', async () => fixture(async (root, put) => {
  await put('package.json', JSON.stringify({ dependencies: { hono: '1' }, devDependencies: { tsx: '1' } }));
  await put('node_modules/hono/package.json', '{}'); await put('node_modules/tsx/package.json', '{}');
  await put('node_modules/tsx/dist/cli.mjs', '');
  const options = { root, nodeVersion: '24.14.0', platform: 'darwin', env: { OWNDAPP_DATA_DIR: 'records', OWNDAPP_PORT: '4311' } };
  assert.equal((await inspectRuntime({ ...options, development: true })).every(c => c.ok), true);
  assert.equal((await inspectRuntime(options)).every(c => c.ok), false);
  await put('dist/index.html', '<html></html>');
  const checks = await inspectRuntime(options);
  assert.equal(checks.every(c => c.ok), true);
  assert.ok(checks.some(c => c.message.includes(join(root, 'records'))));
  assert.equal((await readdir(root)).includes('records'), false);
  await put('records', 'not a directory');
  assert.ok((await inspectRuntime(options)).some(c => !c.ok && c.message.includes('フォルダではありません')));
}));

test('macOSとWindowsは起動可、Windowsは未対応の操作を案内。それ以外のOSは未サポートを明示', async () => fixture(async (root, put) => {
  await put('package.json', JSON.stringify({ dependencies: { hono: '1' }, devDependencies: { tsx: '1' } }));
  await put('node_modules/hono/package.json', '{}'); await put('node_modules/tsx/package.json', '{}');
  await put('node_modules/tsx/dist/cli.mjs', '');
  const before = await readdir(root);
  const run = platform => inspectRuntime({ root, nodeVersion: '24.14.0', platform, env: {}, development: true });
  const mac = await run('darwin');
  assert.equal(mac.every(c => c.ok), true);
  assert.ok(mac.some(c => c.message.startsWith('macOS')));
  const windows = await run('win32');
  assert.equal(windows.every(c => c.ok), true);
  const note = windows.find(c => c.message.startsWith('Windows')).message;
  assert.match(note, /パスを直接入力/);
  assert.match(note, /フォルダ選択ダイアログ・外部アプリ起動は未対応/);
  for (const platform of ['linux', 'freebsd', 'aix']) {
    const failures = (await run(platform)).filter(c => !c.ok);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, new RegExp(`${platform}）はサポート対象外.*macOSとWindows`));
  }
  // The Windows check still enforces the Node minimum and writes nothing.
  assert.ok((await inspectRuntime({ root, nodeVersion: '24.13.9', platform: 'win32', env: {}, development: true })).some(c => !c.ok && c.message.includes('24.14.0以降')));
  assert.deepEqual(await readdir(root), before);
}));

test('使用中ポートでは理由を案内して終了し、既存のサーバーは止めない', async () => fixture(async root => {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  try {
    const port = listener.address().port;
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], {
      cwd: repo, env: { ...process.env, OWNDAPP_PORT: String(port), OWNDAPP_DATA_DIR: join(root, 'data'), OWNDAPP_TEST_PICK_FOLDER: root },
      encoding: 'utf8', timeout: 8000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ポート\d+は使用中です/);
    assert.match(result.stderr, /OWNDAPP_PORT=4311 npm start/);
    assert.equal(listener.listening, true);
  } finally { await new Promise(resolve => listener.close(resolve)); }
}));


test('プロジェクトをシンボリックリンク経由で起動しても準備不足の診断を省略しない', async () => fixture(async (root, put) => {
  await put('package.json', JSON.stringify({ dependencies: {}, devDependencies: {} }));
  await put('tools/doctor.mjs', await readFile(new URL('../tools/doctor.mjs', import.meta.url), 'utf8'));
  const alias = root + '-link';
  await symlink(root, alias);
  try {
    const result = spawnSync(process.execPath, [join(alias, 'tools', 'doctor.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /npm ci --ignore-scripts/);
    assert.equal((await readdir(root)).includes('.owndapp'), false);
  } finally { await rm(alias); }
}));
