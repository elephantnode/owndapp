import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readDependencies, filesChanged } from '../server/dependencies.js';
import { canonicalRoot } from '../server/scanner.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import { fixtureClient, type OsvRecord } from '../server/osv.js';
import { check, preview } from '../server/vulnerabilities.js';

const source = 'registry+https://github.com/rust-lang/crates.io-index';
const packageRow = (name: string, version: string, origin?: string) => `[[package]]\nname="${name}"\nversion="${version}"\n${origin ? `source="${origin}"\n` : ''}`;
async function fixture(fn: (root: string, put: (path: string, text: string) => Promise<void>) => Promise<void>) {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-cargo-')));
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  try { await fn(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}
const candidate = (root: string) => ({ id: 'cargo', name: 'cargo-fixture', path: root, technologies: ['Rust'], components: [], evidence: [], fingerprint: 'cargo', registered: false });

test('Cargoを読み取りBrotliを検索し、公開crates.ioだけを確認付き照会の対象にする', async () => fixture(async (root, put) => {
  await put('Cargo.toml', '[package]\nname="cargo-fixture"\nversion="0.1.0"\n[dependencies]\nbrotli="3"\n');
  const lock = 'version=3\n' + packageRow('cargo-fixture', '0.1.0') + packageRow('brotli', '3.3.4', source) + packageRow('brotli-decompressor', '2.3.4', source) + packageRow('private-crate', '1.0.0', 'registry+https://private.example/index') + packageRow('git-crate', '1.0.0', 'git+https://example.org/repo#abc') + packageRow('local-crate', '1.0.0');
  await put('Cargo.lock', lock);
  const store = new Store(':memory:');
  try {
    const [id] = store.import('cargo', [candidate(root)]).projectIds;
    const api = createApi(store, 4310);
    const headers = { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'content-type': 'application/json', 'x-owndapp-token': '' };
    const call = async (path: string, body?: unknown) => {
      const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    headers['x-owndapp-token'] = (await call('/session')).data.token;
    const read = await call('/dependencies/read', { ids: [id] });
    assert.equal(read.data.results[0].status, 'complete');
    const results = (await call('/dependencies/search?name=Brotli&match=contains')).data;
    assert.deepEqual(results.matches[0].dependencies.map((d: any) => [d.ecosystem, d.name]).sort(), [['crates.io', 'brotli'], ['crates.io', 'brotli-decompressor']]);
    assert.equal(results.coverage.unsupported, 0);
    const planned = preview(store, [id]);
    assert.deepEqual(planned.byEcosystem, { 'crates.io': 2 });
    assert.equal(planned.notSent['rust-source-unverified'], 1); assert.equal(planned.notSent.git, 1); assert.equal(planned.notSent.file, 1);
    const record: OsvRecord = { id: 'RUSTSEC-test-local-only', summary: '架空のテスト用', affected: [{ package: { ecosystem: 'crates.io', name: 'brotli' }, ecosystem_specific: { severity: 'HIGH' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.3.5' }] }] }] };
    const client = fixtureClient({ 'crates.io:brotli@3.3.4': [record] });
    const queries: string[] = [];
    await check(store, { queryBatch: qs => { queries.push(...qs.map(q => `${q.ecosystem}:${q.name}`)); return client.queryBatch(qs); }, vulnerability: id => client.vulnerability(id) }, [id], { retries: 0 });
    assert.deepEqual(queries.sort(), ['crates.io:brotli', 'crates.io:brotli-decompressor']);
    const saved = store.vulnerabilityCheck(id)!;
    assert.equal(saved.status, 'complete'); assert.equal(saved.findings[0].advisories[0].severity, 'high'); assert.equal(saved.findings[0].advisories[0].fixed, '3.3.5');
    const queue = (await call(`/queue?project=${id}`)).data;
    assert.equal(queue.items[0].priority, 'high');
    assert.equal(await readFile(join(root, 'Cargo.lock'), 'utf8'), lock);
  } finally { store.close(); }
}));

test('Cargo workspaceの共通lockはメンバーをカバーし、メンバーmanifest変更を古い結果として検出する', async () => fixture(async (root, put) => {
  await put('Cargo.toml', '[workspace]\nmembers=["crates/*"]\n[workspace.dependencies]\nbrotli="3"\n');
  const member = '[package]\nname="member"\nversion="0.1.0"\n[dependencies]\nbrotli.workspace=true\n';
  await put('crates/member/Cargo.toml', member);
  await put('Cargo.lock', 'version=4\n' + packageRow('member', '0.1.0') + packageRow('brotli', '3.3.4', source));
  const project = { path: root, components: [{ path: 'crates/member', name: 'member', technologies: ['Rust'] }] };
  const result = await readDependencies(project);
  assert.equal(result.status, 'complete');
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.dependencies.map(d => d.name), ['brotli']);
  assert.ok(result.files[0].hashes['crates/member/Cargo.toml']);
  assert.equal(await filesChanged(root, result.files), false);
  await put('crates/member/Cargo.toml', member + '\n# changed\n');
  assert.equal(await filesChanged(root, result.files), true);
}));

test('未対応だけの依存と、npmと同居する未対応の依存を区別し、不完全な照会で解消しない', async () => fixture(async (root, put) => {
  await put('Package.swift', '// swift-tools-version: 6.0\n');
  const unsupported = await readDependencies({ path: root, components: [] });
  assert.equal(unsupported.status, 'failed'); assert.equal(unsupported.files[0].status, 'unsupported');
  await rm(join(root, 'Package.swift'));
  await put('package.json', '{"dependencies":{"example":"1.0.0"}}');
  await put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { example: '1.0.0' } }, 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } } }));
  const store = new Store(':memory:');
  try {
    const [id] = store.import('mixed', [candidate(root)]).projectIds;
    const save = async () => { const result = await readDependencies({ path: root, components: [] }); store.saveDependencies({ projectId: id, readAt: new Date().toISOString(), status: result.status, files: result.files, total: result.dependencies.length, direct: 1 }, result.dependencies); return result; };
    await save();
    await check(store, fixtureClient({ 'example@1.0.0': [{ id: 'GHSA-test-partial', database_specific: { severity: 'HIGH' } }] }), [id], { retries: 0 });
    await put('Package.swift', '// swift-tools-version: 6.0\n');
    const mixed = await save(); assert.equal(mixed.status, 'partial');
    await check(store, fixtureClient({}), [id], { retries: 0 });
    assert.equal(store.vulnerabilityCheck(id)!.status, 'partial');
    assert.equal(store.vulnerabilityCheck(id)!.findings[0].advisories[0].id, 'GHSA-test-partial');
    assert.notEqual(store.responses(id).find(r => r.advisoryId === 'GHSA-test-partial')?.status, 'resolved');
  } finally { store.close(); }
}));
