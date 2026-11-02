import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import { detectTools, listImages, scanImage, scanLockfile, type ScannerRunner } from '../server/osv-scanner.js';
import { fixtureClient } from '../server/osv.js';

// Shaped like osv-scanner 2.7.0's JSON. The advisory is made up for the test and names no real issue.
const record = { id: 'GHSA-test-0000-0002', summary: 'テスト用の架空のアドバイザリ', aliases: ['CVE-0000-0002'], database_specific: { severity: 'HIGH' },
  affected: [{ package: { ecosystem: 'Pub', name: 'http' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '0.13.3' }] }] }] };
const output = (packages: unknown[]) => JSON.stringify({ results: [{ source: { path: 'x', type: 'lockfile' }, packages }], experimental_config: {} });
const pub = { package: { name: 'http', version: '0.12.2', ecosystem: 'Pub' }, vulnerabilities: [record] };

type Ran = { file: string; args: string[] };
function fake(answer: (file: string, args: string[]) => { code: number; stdout?: string; stderr?: string }) {
  const ran: Ran[] = [];
  const runner: ScannerRunner = async (file, args) => { ran.push({ file, args }); const a = answer(file, args); return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }; };
  return { ran, runner };
}
// Nothing that writes files, serves, pulls or runs build scripts may ever be asked for.
const forbidden = (ran: Ran[]) => ran.flatMap(r => r.args).filter(arg => ['fix', '--serve', 'pull', '--call-analysis=rust', '--call-analysis=all'].includes(arg) || arg.startsWith('--call-analysis='));

async function folder(fn: (root: string, put: (file: string, data: string) => Promise<void>) => Promise<void>) {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-scanner-')));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  try { await fn(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}

test('osv-scannerにはlockファイルを形式付きで1件ずつ渡し、呼び出し解析・依存の解決・修正をさせない', async () => {
  await folder(async (root, put) => {
    await put('app/pubspec.lock', 'packages: {}');
    await put('outside/pubspec.lock', 'packages: {}');
    await symlink(join(root, 'outside/pubspec.lock'), join(root, 'app/linked.lock'));
    await mkdir(join(root, 'app/sub'), { recursive: true }); await symlink(join(root, 'outside/pubspec.lock'), join(root, 'app/sub/pubspec.lock'));
    const { ran, runner } = fake(() => ({ code: 1, stdout: output([pub]) }));
    const packages = await scanLockfile('/bin/osv-scanner', join(root, 'app'), 'pubspec.lock', { runner });
    assert.deepEqual(packages.map(p => [p.ecosystem, p.name, p.version, p.records.map(r => r.id)]), [['Pub', 'http', '0.12.2', ['GHSA-test-0000-0002']]]);
    assert.deepEqual(ran[0].args, ['scan', 'source', '--format', 'json', '--no-call-analysis=all', '--no-resolve', '-L', `pubspec.lock:${join(root, 'app/pubspec.lock')}`]);
    // A file that resolves outside the project folder is refused before anything runs.
    await assert.rejects(scanLockfile('/bin/osv-scanner', join(root, 'app'), 'sub/pubspec.lock', { runner }), /フォルダの外/);
    await assert.rejects(scanLockfile('/bin/osv-scanner', join(root, 'app'), 'linked.lock', { runner }), /フォルダの外|読めない形式/);
    assert.equal(ran.length, 1);
    // 128 means no packages; other codes are failures, never "no vulnerabilities".
    assert.deepEqual(await scanLockfile('/bin/osv-scanner', join(root, 'app'), 'pubspec.lock', { runner: fake(() => ({ code: 128 })).runner }), []);
    await assert.rejects(scanLockfile('/bin/osv-scanner', join(root, 'app'), 'pubspec.lock', { runner: fake(() => ({ code: 127, stderr: 'boom' })).runner }), /boom/);
    await assert.rejects(scanLockfile('/bin/osv-scanner', join(root, 'app'), 'pubspec.lock', { runner: fake(() => ({ code: 1, stdout: 'not json' })).runner }), /読み取れません/);
    assert.deepEqual(forbidden(ran), []);
  });
});

test('Dockerイメージは手元にあるものだけを書き出して照会し、一時ファイルは失敗しても消す', async () => {
  await folder(async temp => {
    const tools = { osvScanner: '/bin/osv-scanner', docker: '/bin/docker' };
    const missing = fake(() => ({ code: 1, stderr: 'No such image' }));
    await assert.rejects(scanImage(tools, 'web:latest', { runner: missing.runner, temp }), /手元にない/);
    assert.deepEqual(missing.ran.map(r => r.args.slice(0, 2)), [['image', 'inspect']], 'a missing image is never pulled or saved');
    await assert.rejects(scanImage(tools, '--help', { runner: missing.runner, temp }), /イメージ名/);
    const ok = fake((file, args) => file === tools.docker ? { code: 0, stdout: args[1] === 'inspect' ? 'sha256:abc\n' : '' } : { code: 1, stdout: output([pub]) });
    const result = await scanImage(tools, 'web:latest', { runner: ok.runner, temp });
    assert.equal(result.imageId, 'sha256:abc');
    assert.equal(result.packages.length, 1);
    const scan = ok.ran.find(r => r.file === tools.osvScanner)!;
    assert.deepEqual(scan.args.slice(0, 6), ['scan', 'image', '--archive', '--format', 'json', '--no-call-analysis=all']);
    assert.deepEqual(await readdir(temp), [], 'the saved archive is removed');
    const failing = fake(file => file === tools.docker ? { code: 0, stdout: 'sha256:abc' } : { code: 127, stderr: 'scan failed' });
    await assert.rejects(scanImage(tools, 'web:latest', { runner: failing.runner, temp }), /scan failed/);
    assert.deepEqual(await readdir(temp), [], 'removed after a failure too');
    assert.deepEqual(forbidden([...ok.ran, ...failing.ran]), []);
  });
});

test('ツールの有無とDockerの起動を確かめ、名前のないイメージは一覧に出さない', async () => {
  const { runner } = fake((file, args) => file.endsWith('osv-scanner') ? { code: 0, stdout: 'osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\n' } : { code: args[0] === 'info' ? 1 : 0 });
  assert.deepEqual(await detectTools(runner, async name => `/bin/${name}`), { osvScanner: { path: '/bin/osv-scanner', version: '2.7.0' }, docker: { path: '/bin/docker', running: false } });
  assert.deepEqual(await detectTools(runner, async () => null), { osvScanner: null, docker: null });
  const listed = fake(() => ({ code: 0, stdout: [
    JSON.stringify({ Repository: 'web', Tag: 'latest', ID: 'abc', Size: '120MB', CreatedSince: '2 days ago' }),
    JSON.stringify({ Repository: '<none>', Tag: '<none>', ID: 'def' }),
    'not json', '',
  ].join('\n') }));
  assert.deepEqual((await listImages('/bin/docker', listed.runner)).map(i => i.reference), ['web:latest']);
});

test('osv-scannerを使う設定にすると、未対応のlockファイルとイメージの結果を由来付きで取り込み、照会を完了にできる', async () => {
  await folder(async (root, put) => {
    await put('flutter-app/pubspec.yaml', 'name: flutter_app\n');
    await put('flutter-app/pubspec.lock', 'packages: {}\n');
    const store = new Store(':memory:');
    const tools = { osvScanner: '/bin/osv-scanner', docker: '/bin/docker' };
    const { ran, runner } = fake((file, args) => file === tools.docker ? { code: 0, stdout: args[1] === 'inspect' ? 'sha256:img1' : '' }
      : args[0] === '--version' ? { code: 0, stdout: 'osv-scanner version: 2.7.0' }
      : args[1] === 'image' ? { code: 1, stdout: output([{ package: { name: 'openssl', version: '3.0.2-0ubuntu1', ecosystem: 'Ubuntu:22.04:LTS' }, vulnerabilities: [{ id: 'UBUNTU-test-0001', summary: 'テスト用', affected: [{ package: { ecosystem: 'Ubuntu:22.04:LTS', name: 'openssl' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.2-0ubuntu1.10' }] }] }] }] }]) }
      : { code: 1, stdout: output([pub]) });
    const api = createApi(store, 4310, undefined, undefined, { osv: fixtureClient({}), scannerRunner: runner, findTool: async name => `/bin/${name}` });
    let token = '';
    const call = async (path: string, body?: unknown, method = 'POST') => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : method,
        headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as any; if (path === '/session') token = data.token; return { response, data };
    };
    const check = async (ids: string[]) => {
      let job = (await call('/vulnerabilities/check', { ids })).data.job;
      for (let i = 0; i < 500 && job.status === 'running'; i++) { await new Promise(r => setTimeout(r, 2)); job = (await call('/vulnerabilities/job')).data.job; }
      return job;
    };
    try {
      await call('/session');
      const [id] = store.import('flutter', [{ id: 'f', name: 'flutter-app', path: join(root, 'flutter-app'), technologies: ['Dart'], components: [], evidence: [], fingerprint: 'x', registered: false }]).projectIds;
      await call('/dependencies/read', { ids: [id] });
      // Off by default: the lockfile stays unchecked, nothing runs, and the app is not diagnosable.
      assert.equal((await call('/scanner')).data.enabled, false);
      assert.equal((await call('/projects')).data.projects[0].diagnosable, false);
      assert.equal((await call('/vulnerabilities/preview', { ids: [id] })).data.scanner, null);
      assert.equal((await check([id])).result.results[0].status, 'nothing-to-check');
      assert.equal(ran.filter(r => r.args[0] === 'scan').length, 0);
      // Turned on: the app becomes diagnosable, the confirmation names the file and image, and the result carries where it came from.
      assert.equal((await call('/scanner', { enabled: true }, 'PUT')).data.enabled, true);
      assert.equal((await call(`/projects/${id}/images`, { images: ['-rm'] }, 'PUT')).response.status, 400);
      await call(`/projects/${id}/images`, { images: ['flutter-app:latest'] }, 'PUT');
      assert.equal((await call('/projects')).data.projects[0].diagnosable, true);
      const preview = (await call('/vulnerabilities/preview', { ids: [id] })).data;
      assert.deepEqual(preview.scanner, { formats: { 'Dart (pubspec.lock)': 1 }, images: [{ project: 'flutter-app', image: 'flutter-app:latest' }] });
      assert.deepEqual(preview.nothingToSend, []);
      const job = await check([id]);
      assert.equal(job.status, 'done');
      const saved = store.vulnerabilityCheck(id)!;
      assert.equal(saved.status, 'complete', 'every unsupported file and linked image was covered');
      assert.deepEqual(saved.scanner, { files: ['pubspec.lock'], images: { 'flutter-app:latest': 'sha256:img1' }, failed: [] });
      const byOrigin = Object.fromEntries(saved.findings.map(f => [f.via?.file ?? f.via?.image, [f.dependency.ecosystem, f.dependency.name, f.advisories.map(a => [a.id, a.fixed])]]));
      assert.deepEqual(byOrigin, {
        'pubspec.lock': ['Pub', 'http', [['GHSA-test-0000-0002', '0.13.3']]],
        'flutter-app:latest': ['Ubuntu:22.04:LTS', 'openssl', [['UBUNTU-test-0001', '3.0.2-0ubuntu1.10']]],
      });
      // An image that is not here any more leaves the result partial, keeping what was found before.
      const gone = fake((file, args) => file === tools.docker ? { code: args[1] === 'inspect' ? 1 : 0 } : args[0] === '--version' ? { code: 0, stdout: 'osv-scanner version: 2.7.0' } : { code: 1, stdout: output([pub]) });
      const again = createApi(store, 4310, undefined, undefined, { osv: fixtureClient({}), scannerRunner: gone.runner, findTool: async name => `/bin/${name}` });
      const session = await (await again.request('http://127.0.0.1:4310/api/session', { headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web' } })).json() as { token: string };
      const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': session.token, 'content-type': 'application/json' };
      await again.request('http://127.0.0.1:4310/api/vulnerabilities/check', { method: 'POST', headers, body: JSON.stringify({ ids: [id] }) });
      for (let i = 0; i < 500 && store.vulnerabilityCheck(id)!.scanner?.failed.length === 0; i++) await new Promise(r => setTimeout(r, 2));
      const partial = store.vulnerabilityCheck(id)!;
      assert.equal(partial.status, 'partial');
      assert.match(partial.scanner!.failed[0].message, /手元にない/);
      assert.ok(partial.findings.some(f => f.via?.image === 'flutter-app:latest' && f.retained), 'the earlier image finding is kept, not resolved');
      assert.deepEqual(forbidden([...ran, ...gone.ran]), []);
    } finally { store.close(); }
  });
});

test('Package.resolvedは形式名なしで渡し、隣のPackage.swiftも照会済みとみなす。初回に何も照会できなければ保存しない', async () => {
  await folder(async (root, put) => {
    await put('ios/Package.swift', '// swift-tools-version: 5.9\n');
    await put('ios/Package.resolved', '{"pins":[],"version":2}');
    const swift = { package: { name: 'github.com/apple/swift-nio', version: '2.29.0', ecosystem: 'SwiftURL' }, vulnerabilities: [{ ...record, affected: [] }] };
    let fail = true;
    const { ran, runner } = fake((_file, args) => args[0] === '--version' ? { code: 0, stdout: 'osv-scanner version: 2.7.0' } : fail ? { code: 127, stderr: 'could not determine extractor' } : { code: 1, stdout: output([swift]) });
    const store = new Store(':memory:');
    const api = createApi(store, 4310, undefined, undefined, { osv: fixtureClient({}), scannerRunner: runner, findTool: async name => name === 'osv-scanner' ? '/bin/osv-scanner' : null });
    let token = '';
    const call = async (path: string, body?: unknown, method = 'POST') => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : method,
        headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as any; if (path === '/session') token = data.token; return { response, data };
    };
    const check = async (ids: string[]) => {
      let job = (await call('/vulnerabilities/check', { ids })).data.job;
      for (let i = 0; i < 500 && job.status === 'running'; i++) { await new Promise(r => setTimeout(r, 2)); job = (await call('/vulnerabilities/job')).data.job; }
      return job;
    };
    try {
      await call('/session');
      const [id] = store.import('ios', [{ id: 'i', name: 'ios', path: join(root, 'ios'), technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false }]).projectIds;
      await call('/dependencies/read', { ids: [id] });
      await call('/scanner', { enabled: true }, 'PUT');
      assert.equal((await check([id])).result.results[0].status, 'failed');
      assert.equal(store.vulnerabilityCheck(id), null, 'a first attempt that judged nothing is not stored as a result');
      fail = false;
      assert.equal((await check([id])).result.results[0].status, 'complete', 'Package.swift is covered by the Package.resolved beside it');
      assert.equal(store.vulnerabilityCheck(id)!.findings[0].dependency.ecosystem, 'SwiftURL');
      assert.ok(ran.filter(r => r.args[0] === 'scan').every(r => r.args.at(-1) === join(root, 'ios/Package.resolved')), 'passed as a bare path');
    } finally { store.close(); }
  });
});
