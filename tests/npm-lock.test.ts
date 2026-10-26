import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { classifySource, parseNpmLock } from '../server/npm-lock.js';
import { filesChanged, readDependencies as readNpmDependencies } from '../server/dependencies.js';
import type { Dependency } from '../shared/types.js';

const json = (value: unknown) => JSON.stringify(value);
const find = (rows: Dependency[], name: string, version?: string) => rows.filter(d => d.name === name && (!version || d.version === version));
const npm = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

async function folder(fn: (root: string, put: (file: string, data: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-npm-'));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  try { await fn(await canonicalRoot(root), put); } finally { await rm(root, { recursive: true, force: true }); }
}

test('v3: 直接・間接、同名の複数版、開発用、別名を区別する', () => {
  const manifest = { name: 'app', dependencies: { next: '^15.0.0', 'old-lodash': 'npm:lodash@^3.0.0' }, devDependencies: { vitest: '^2.0.0' } };
  const lock = { lockfileVersion: 3, packages: {
    '': { name: 'app', dependencies: { next: '^15.0.0', 'old-lodash': 'npm:lodash@^3.0.0' }, devDependencies: { vitest: '^2.0.0' } },
    'node_modules/next': { version: '15.1.0', resolved: npm('next', '15.1.0') },
    'node_modules/semver': { version: '7.6.0', resolved: npm('semver', '7.6.0') },
    'node_modules/next/node_modules/semver': { version: '6.3.1', resolved: npm('semver', '6.3.1') },
    'node_modules/old-lodash': { name: 'lodash', version: '3.10.1', resolved: npm('lodash', '3.10.1') },
    'node_modules/vitest': { version: '2.1.0', dev: true, resolved: npm('vitest', '2.1.0') },
    'node_modules/@types/node': { version: '22.0.0', dev: true, resolved: npm('@types/node', '22.0.0') },
  } };
  const parsed = parseNpmLock(json(lock), json(manifest), '');
  assert.equal(parsed.status, 'ok'); assert.equal(parsed.lockfileVersion, 3);
  const rows = parsed.dependencies;
  assert.deepEqual(find(rows, 'next')[0], { ecosystem: 'npm', name: 'next', version: '15.1.0', requested: '^15.0.0', direct: true, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '' });
  assert.deepEqual(find(rows, 'semver').map(d => [d.version, d.direct]).sort(), [['6.3.1', false], ['7.6.0', false]]);
  assert.equal(find(rows, 'lodash', '3.10.1')[0].direct, true, 'aliases are recorded under the real package name');
  assert.equal(find(rows, 'old-lodash').length, 0);
  assert.equal(find(rows, 'vitest')[0].scope, 'dev');
  assert.equal(find(rows, '@types/node')[0].name, '@types/node');
});

test('v1: 入れ子の dependencies をたどり、宣言との差を検出する', () => {
  const manifest = { dependencies: { express: '^4.17.0' }, devDependencies: { mocha: '^10.0.0' } };
  const lock = { lockfileVersion: 1, dependencies: {
    express: { version: '4.17.1', resolved: npm('express', '4.17.1'), dependencies: { debug: { version: '2.6.9', resolved: npm('debug', '2.6.9') } } },
    debug: { version: '4.3.4', resolved: npm('debug', '4.3.4') },
    mocha: { version: '10.2.0', dev: true, resolved: npm('mocha', '10.2.0') },
    mine: { version: 'file:../mine' },
  } };
  const parsed = parseNpmLock(json(lock), json(manifest), 'api');
  assert.equal(parsed.status, 'ok');
  assert.equal(find(parsed.dependencies, 'express')[0].direct, true);
  assert.equal(find(parsed.dependencies, 'express')[0].component, 'api');
  assert.equal(find(parsed.dependencies, 'express')[0].file, 'api/package-lock.json');
  assert.deepEqual(find(parsed.dependencies, 'debug').map(d => d.version).sort(), ['2.6.9', '4.3.4']);
  assert.equal(find(parsed.dependencies, 'mocha')[0].scope, 'dev');
  assert.equal(find(parsed.dependencies, 'mine')[0].source, 'file');
  const stale = parseNpmLock(json(lock), json({ dependencies: { express: '^4.17.0', axios: '^1.0.0' } }), '');
  assert.equal(stale.status, 'mismatch'); assert.match(stale.message, /axios/);
  assert.ok(stale.dependencies.length > 0, 'a mismatch still records what the lock holds');
});

test('v2・workspace: メンバーの直接依存と、ホイストされた依存の帰属', () => {
  const manifest = { name: 'mono', workspaces: ['packages/*'], devDependencies: { typescript: '5.6.0' } };
  const lock = { lockfileVersion: 2, packages: {
    '': { name: 'mono', workspaces: ['packages/*'], devDependencies: { typescript: '5.6.0' } },
    'packages/web': { name: 'web', dependencies: { react: '^19.0.0' } },
    'packages/api': { name: 'api', dependencies: { hono: '^4.0.0' } },
    'node_modules/web': { resolved: 'packages/web', link: true },
    'node_modules/react': { version: '19.0.0', resolved: npm('react', '19.0.0') },
    'node_modules/typescript': { version: '5.6.0', dev: true, resolved: npm('typescript', '5.6.0') },
    'packages/api/node_modules/hono': { version: '4.6.0', resolved: npm('hono', '4.6.0') },
  }, dependencies: { react: { version: '19.0.0' } } };
  const parsed = parseNpmLock(json(lock), json(manifest), '');
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.members.sort(), ['packages/api', 'packages/web']);
  assert.equal(find(parsed.dependencies, 'web').length, 0, 'workspace links are members, not dependencies');
  assert.deepEqual(find(parsed.dependencies, 'react')[0], { ecosystem: 'npm', name: 'react', version: '19.0.0', requested: '^19.0.0', direct: true, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '' });
  assert.equal(find(parsed.dependencies, 'hono')[0].component, 'packages/api');
  assert.equal(find(parsed.dependencies, 'hono')[0].direct, true);
});

test('取得元を公開npm・別のレジストリ・URL・git・file に分ける', () => {
  assert.equal(classifySource(npm('a', '1.0.0'), '1.0.0'), 'registry');
  assert.equal(classifySource('https://npm.example.com/a/-/a-1.0.0.tgz', '1.0.0'), 'other-registry');
  assert.equal(classifySource('https://example.com/build/a.tgz', '1.0.0'), 'url');
  assert.equal(classifySource('git+ssh://git@github.com/x/y.git#abc', '1.0.0'), 'git');
  assert.equal(classifySource(null, 'github:x/y'), 'git');
  assert.equal(classifySource(null, 'file:../x'), 'file');
  // No resolved URL: a plain version comes from the configured registry; anything else stays unknown.
  assert.equal(classifySource(null, '1.0.0'), 'registry-unrecorded');
  assert.equal(classifySource(null, '2.0.0-rc.1'), 'registry-unrecorded');
  assert.equal(classifySource(null, 'latest'), 'unknown');
  assert.equal(classifySource(null, null), 'unknown');
});

test('壊れたJSON・未知の形式は未確認として返す', () => {
  assert.equal(parseNpmLock('{', null, '').status, 'invalid');
  assert.equal(parseNpmLock(json({ lockfileVersion: 4, packages: {} }), null, '').status, 'unsupported');
  assert.equal(parseNpmLock(json({ name: 'x' }), null, '').status, 'unsupported');
  assert.equal(parseNpmLock(json({ lockfileVersion: 3 }), null, '').status, 'invalid');
  const noManifest = parseNpmLock(json({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }), null, '');
  assert.equal(noManifest.status, 'mismatch'); assert.equal(noManifest.dependencies.length, 1);
});

test('プロジェクトとComponentのlockを読み、shrinkwrap優先・lockなし・symlink・サイズ上限を扱い、ファイルを変えない', async () => {
  await folder(async (root, put) => {
    const lock = (deps: Record<string, string>) => json({ lockfileVersion: 3, packages: { '': { dependencies: deps }, ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v.replace('^', ''), resolved: npm(n, v.replace('^', '')) }])) } });
    await put('package.json', json({ dependencies: { vue: '^3.5.0' } }));
    await put('package-lock.json', lock({ vue: '^3.5.0' }));
    await put('npm-shrinkwrap.json', lock({ vue: '^3.5.0' }));
    await put('api/package.json', json({ dependencies: { express: '^4.0.0' } }));
    await put('api/package-lock.json', lock({ express: '^4.0.0' }));
    await put('worker/package.json', json({ dependencies: { zod: '^3.0.0' } }));
    await put('outside/package-lock.json', lock({ evil: '^1.0.0' }));
    await mkdir(join(root, 'linked'));
    await put('linked/package.json', json({}));
    await symlink(join(root, 'outside/package-lock.json'), join(root, 'linked/package-lock.json'));
    const before = await readFile(join(root, 'package-lock.json'), 'utf8');
    const project = { path: root, components: [{ name: 'api', path: 'api', technologies: [] }, { name: 'worker', path: 'worker', technologies: [] }, { name: 'linked', path: 'linked', technologies: [] }] };
    const result = await readNpmDependencies(project);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.files.map(f => [f.path, f.status]), [['npm-shrinkwrap.json', 'ok'], ['api/package-lock.json', 'ok'], ['linked/package-lock.json', 'unreadable'], ['worker/package.json', 'no-lock']]);
    assert.deepEqual(result.dependencies.map(d => [d.name, d.component]).sort(), [['express', 'api'], ['vue', '']]);
    assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), before);
    assert.equal(await filesChanged(root, result.files), false);
    await put('api/package-lock.json', lock({ express: '^4.21.0' }));
    assert.equal(await filesChanged(root, result.files), true);
    await truncate(join(root, 'npm-shrinkwrap.json'), 33 * 1024 * 1024);
    assert.equal((await readNpmDependencies({ path: root, components: [] })).files[0].status, 'too-large');
  });
});

test('workspaceのメンバーは外側のlockで読めていれば lockなし と数えない', async () => {
  await folder(async (root, put) => {
    await put('package.json', json({ workspaces: ['packages/*'] }));
    await put('package-lock.json', json({ lockfileVersion: 3, packages: { '': { workspaces: ['packages/*'] }, 'packages/web': { dependencies: { react: '^19.0.0' } },
      'node_modules/react': { version: '19.0.0', resolved: npm('react', '19.0.0') } } }));
    await put('packages/web/package.json', json({ dependencies: { react: '^19.0.0' } }));
    const result = await readNpmDependencies({ path: root, components: [{ name: 'web', path: 'packages/web', technologies: [] }] });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.files.map(f => f.path), ['package-lock.json']);
    const none = await readNpmDependencies({ path: join(root, 'packages/web'), components: [] });
    assert.equal(none.status, 'no-lock');
  });
});
