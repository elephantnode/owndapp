import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyGuard, inspectGuard } from '../server/guard.js';
import { CatalogError } from '../server/store.js';

const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'example', version: '1.0.0', ...extra });

async function fixture(files: Record<string, string | Buffer>, fn: (root: string) => Promise<void>) {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'owndapp-guard-')));
  try {
    for (const [name, data] of Object.entries(files)) await writeFile(join(outer, name), data);
    await fn(outer);
  } finally { await rm(outer, { recursive: true, force: true }); }
}

const backups = async (root: string) => (await readdir(root)).filter(name => name.startsWith('.npmrc.owndapp-'));

test('creates .npmrc with only the Guard registry and is idempotent', () => fixture({ 'package.json': manifest({ packageManager: 'npm@11.0.0' }) }, async root => {
  const before = await inspectGuard(root);
  assert.equal(before.state, 'available');
  const result = await applyGuard(root, before.revision);
  assert.equal(result.state, 'configured');
  assert.equal(result.backup, undefined);
  assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), 'registry=https://npm.flatt.tech/\n');
  assert.equal((await stat(join(root, '.npmrc'))).mode & 0o777, 0o600);
  assert.deepEqual(await backups(root), []);
  const again = await applyGuard(root, result.revision);
  assert.equal(again.state, 'configured');
  assert.equal(again.backup, undefined);
  assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), 'registry=https://npm.flatt.tech/\n');
}));

test('appends while preserving comments, scopes and exact bytes, with an exact backup', async () => {
  const original = '# team settings\r\nignore-scripts=true\r\n@acme:registry=https://npm.example.com/\r\n//npm.example.com/:_authToken=${ACME_TOKEN}\r\nsave-exact=true';
  await fixture({ 'package.json': manifest(), '.npmrc': original }, async root => {
    await chmod(join(root, '.npmrc'), 0o640);
    const before = await inspectGuard(root);
    assert.equal(before.state, 'available');
    assert.ok(before.warnings.some(w => w.includes('スコープ')));
    assert.ok(before.warnings.some(w => w.includes('packageManager')));
    assert.ok(!JSON.stringify(before).includes('ACME_TOKEN') && !JSON.stringify(before).includes('npm.example.com'));
    const result = await applyGuard(root, before.revision);
    assert.equal(result.state, 'configured');
    assert.match(result.backup!, /^\.npmrc\.owndapp-backup-[\w-]+$/);
    assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), `${original}\r\nregistry=https://npm.flatt.tech/\r\n`);
    assert.deepEqual(await readFile(join(root, result.backup!)), Buffer.from(original));
    assert.equal((await stat(join(root, result.backup!))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, '.npmrc'))).mode & 0o777, 0o640);
    assert.deepEqual(await backups(root), [result.backup]);
  });
});

test('replaces only the public npm registry line', () => fixture({ 'package.json': manifest({ packageManager: 'pnpm@9.0.0' }), 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  '.npmrc': '; keep\n  registry = https://registry.npmjs.org/\nfund=false\n' }, async root => {
  const before = await inspectGuard(root);
  assert.equal(before.state, 'available');
  await applyGuard(root, before.revision);
  assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), '; keep\n  registry=https://npm.flatt.tech/\nfund=false\n');
  assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n');
}));

test('existing Guard registry is reported as configured without rewriting', () => fixture({ 'package.json': manifest(), '.npmrc': 'registry=https://npm.flatt.tech/\n#x' }, async root => {
  const before = await inspectGuard(root);
  assert.equal(before.state, 'configured');
  const result = await applyGuard(root, before.revision);
  assert.equal(result.backup, undefined);
  assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), 'registry=https://npm.flatt.tech/\n#x');
}));

for (const [label, npmrc] of [
  ['private registry', 'registry=https://npm.internal.example/\n'],
  ['duplicate registry', 'registry=https://registry.npmjs.org/\nregistry=https://registry.npmjs.org/\n'],
  ['variable registry', 'registry=${REGISTRY}\n'],
  ['variable key', '${KEY}=https://registry.npmjs.org/\n'],
  ['quoted registry', 'registry="https://registry.npmjs.org/"\n'],
  ['unscoped token', '_authToken=secret-value\n'],
  ['unscoped auth', '_auth=c2VjcmV0\n'],
  ['guard credentials', '//npm.flatt.tech/:_authToken=secret-value\n'],
  ['disabled TLS checks', 'strict-ssl=false\n'],
  ['custom CA', 'cafile=/tmp/ca.pem\n'],
  ['section', '[default]\nregistry=https://registry.npmjs.org/\n'],
] as const) {
  test(`blocks ${label} without exposing contents`, () => fixture({ 'package.json': manifest(), '.npmrc': npmrc }, async root => {
    const status = await inspectGuard(root);
    assert.equal(status.state, 'blocked');
    assert.ok(!JSON.stringify(status).includes('secret-value') && !JSON.stringify(status).includes('internal'));
    await assert.rejects(applyGuard(root, status.revision), (error: CatalogError) => error.status === 409);
    assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), npmrc);
    assert.deepEqual(await backups(root), []);
  }));
}

test('blocks symlinked and hardlinked .npmrc and symlinked manifests', () => fixture({ 'package.json': manifest(), 'elsewhere': 'fund=false\n' }, async root => {
  await symlink(join(root, 'elsewhere'), join(root, '.npmrc'));
  assert.equal((await inspectGuard(root)).state, 'blocked');
  await rm(join(root, '.npmrc'));
  await link(join(root, 'elsewhere'), join(root, '.npmrc'));
  const hard = await inspectGuard(root);
  assert.equal(hard.state, 'blocked');
  await assert.rejects(applyGuard(root, hard.revision), CatalogError);
  assert.equal(await readFile(join(root, 'elsewhere'), 'utf8'), 'fund=false\n');
  await rm(join(root, '.npmrc'));
  await rm(join(root, 'package.json'));
  await symlink(join(root, 'elsewhere'), join(root, 'package.json'));
  assert.equal((await inspectGuard(root)).state, 'blocked');
}));

test('blocks a project path that is not canonical', () => fixture({ 'package.json': manifest() }, async root => {
  const alias = `${root}-alias`;
  await symlink(root, alias);
  try { assert.equal((await inspectGuard(alias)).state, 'blocked'); } finally { await rm(alias); }
}));

test('blocks oversized or non-JSON manifests', async () => {
  await fixture({ 'package.json': '{oops' }, async root => assert.equal((await inspectGuard(root)).state, 'blocked'));
  await fixture({ 'package.json': manifest(), '.npmrc': `#${'x'.repeat(64 * 1024)}` }, async root => assert.equal((await inspectGuard(root)).state, 'blocked'));
});

test('reports unsupported managers instead of claiming coverage', async () => {
  await fixture({}, async root => assert.equal((await inspectGuard(root)).state, 'unsupported'));
  for (const packageManager of ['yarn@4.0.0', 'bun@1.1.0', 'custom@1.0.0'])
    await fixture({ 'package.json': manifest({ packageManager }) }, async root => assert.equal((await inspectGuard(root)).state, 'unsupported'));
  for (const file of ['yarn.lock', '.yarnrc.yml', 'bun.lockb'])
    await fixture({ 'package.json': manifest(), [file]: '' }, async root => {
      const status = await inspectGuard(root);
      assert.equal(status.state, 'unsupported');
      await assert.rejects(applyGuard(root, status.revision), CatalogError);
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.npmrc')), []);
    });
  await fixture({ 'package.json': manifest(), 'package-lock.json': '{}', 'pnpm-lock.yaml': '' }, async root => assert.equal((await inspectGuard(root)).state, 'blocked'));
  await fixture({ 'package.json': manifest({ packageManager: 'pnpm@9.0.0' }), 'pnpm-workspace.yaml': 'registry: https://npm.internal.example/\n' },
    async root => assert.equal((await inspectGuard(root)).state, 'blocked'));
});

test('rejects stale revisions after the manifest or .npmrc changes', () => fixture({ 'package.json': manifest(), '.npmrc': 'fund=false\n' }, async root => {
  const before = await inspectGuard(root);
  await writeFile(join(root, 'package.json'), manifest({ packageManager: 'npm@11.0.0' }));
  await assert.rejects(applyGuard(root, before.revision), (error: CatalogError) => error.status === 409);
  const middle = await inspectGuard(root);
  assert.notEqual(middle.revision, before.revision);
  await writeFile(join(root, '.npmrc'), 'fund=true\n');
  await assert.rejects(applyGuard(root, middle.revision), (error: CatalogError) => error.status === 409);
  assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), 'fund=true\n');
  assert.deepEqual(await backups(root), []);
}));

test('warns about lock entries fetched outside public npm', () => fixture({ 'package.json': manifest({ packageManager: 'npm@11.0.0' }),
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/a': { resolved: 'https://git.example/a.tgz' } } }) }, async root => {
  const status = await inspectGuard(root);
  assert.equal(status.state, 'available');
  assert.ok(status.warnings.some(w => w.includes('package-lock.json')));
}));

test('Guard lock URLs do not produce a bypass warning and applying preserves the lock', () => fixture({
  'package.json': manifest({ packageManager: 'npm@11.0.0' }),
  'package-lock.json': JSON.stringify({ packages: { 'node_modules/a': { resolved: 'https://npm.flatt.tech/a/-/a-1.0.0.tgz' } } }),
}, async root => {
  const lock = await readFile(join(root, 'package-lock.json'));
  const before = await inspectGuard(root);
  assert.equal(before.state, 'available');
  assert.ok(!before.warnings.some(w => w.includes('package-lock.json')));
  await applyGuard(root, before.revision);
  assert.deepEqual(await readFile(join(root, 'package-lock.json')), lock);
}));
