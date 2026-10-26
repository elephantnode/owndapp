import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot, newScan, readSafe, revalidateCandidate, runScan } from '../server/scanner.js';
import { Store, CatalogError } from '../server/store.js';
import { createApi } from '../server/api.js';
import type { AppOpener, AppPicker, FolderOpener, FolderPicker } from '../server/folder-picker.js';
import type { Candidate, Project, Scan } from '../shared/types.js';

async function fixture(fn: (root: string, put: (file: string, data: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-test-'));
  const put = async (file: string, data: string) => { const { dirname } = await import('node:path'); await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  try { await fn(await canonicalRoot(root), put); } finally { await rm(root, { recursive: true, force: true }); }
}
const candidate = (path = '/fixture/one'): Candidate => ({ id: 'candidate', path, name: 'example', technologies: ['Vue'], components: [], evidence: [{ file: 'package.json', detail: 'vue declaration' }], fingerprint: 'hash', registered: false });
const edit = (p: Project) => ({ revision: p.revision, name: p.name, purpose: '個人用のツール', tags: ['tool'], notes: '', lifecycle: 'maintained' as const, archiveReason: '' });

test('複数言語を発見し、明示されたworkspaceのComponentを親にまとめる', async () => {
  await fixture(async (root, put) => {
    await put('web/package.json', JSON.stringify({ name: 'workspace', workspaces: ['apps/*'], private: true }));
    await put('web/apps/front/package.json', JSON.stringify({ name: 'front', dependencies: { next: '^15' } }));
    await put('web/apps/api/package.json', JSON.stringify({ name: 'api' }));
    await put('python/pyproject.toml', '[project]\nname="reports"\nrequires-python=">=3.12"');
    await put('rust/Cargo.toml', '[package]\nname="worker"\nversion="0.1.0"');
    await put('php/composer.json', JSON.stringify({ name: 'personal/api', require: { php: '^8.3' } }));
    await put('go/go.mod', 'module example.com/tool\n\ngo 1.23');
    await put('lambda/template.yaml', 'Resources:\n  Fn:\n    Type: AWS::Serverless::Function\n    Properties:\n      Runtime: nodejs22.x');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.status, 'completed'); assert.equal(scan.candidates.length, 6);
    const web = scan.candidates.find(c => c.name === 'workspace')!;
    assert.equal(web.components.length, 2); assert.ok(web.technologies.includes('Next.js'));
    assert.ok(scan.candidates.some(c => c.technologies.includes('AWS Lambda設定')));
    await revalidateCandidate(root, web);
  });
});

test('依存物・symlinkを除外し、設定のコードを実行しない', async () => {
  await fixture(async (root, put) => {
    await put('app/package.json', '{"name":"source"}');
    await put('app/node_modules/not-a-project/package.json', '{"name":"dependency"}');
    await put('script/setup.py', 'raise Exception("must not execute")');
    await symlink(join(root, 'app'), join(root, 'linked'));
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.candidates.length, 2); assert.ok(scan.excluded >= 2);
    assert.ok(scan.candidates.some(c => c.technologies.includes('Python')));
  });
});

test('範囲外のファイルとsymlinkの読み取りを拒否する', async () => {
  await fixture(async (root, put) => {
    await put('project/package.json', '{"name":"safe"}');
    await symlink('/etc/hosts', join(root, 'secret'));
    await assert.rejects(readSafe(root, join(root, 'secret')));
    await symlink(join(root, 'project/package.json'), join(root, 'manifest'));
    await assert.rejects(readSafe(root, join(root, 'manifest')));
  });
});

test('壊れたmanifestも未確認の候補として登録可能にし、正常と判定しない', async () => {
  await fixture(async (root, put) => {
    await put('broken/package.json', '{broken');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.status, 'partial'); assert.equal(scan.candidates.length, 1);
    assert.ok(scan.candidates[0].evidence.some(e => e.detail.includes('失敗')));
    await revalidateCandidate(root, scan.candidates[0]);
  });
});

test('登録直前の変更とファイル消失を検出する', async () => {
  await fixture(async (root, put) => {
    await put('app/package.json', '{"name":"before"}');
    const scan = newScan(root); await runScan(scan);
    await put('app/package.json', '{"name":"after"}');
    await assert.rejects(revalidateCandidate(root, scan.candidates[0]));
    await rm(join(root, 'app/package.json'));
    await assert.rejects(revalidateCandidate(root, scan.candidates[0]));
  });
});

test('深さ上限・キャンセルを完了と表示しない', async () => {
  await fixture(async (root, put) => {
    await put('nested/inner/package.json', '{"name":"deep"}');
    const scan = newScan(root); await runScan(scan, undefined, undefined, { depth: 0 });
    assert.equal(scan.status, 'partial'); assert.ok(scan.issues.length);
    const controller = new AbortController(); controller.abort();
    const cancelled = newScan(root); await runScan(cancelled, undefined, controller.signal);
    assert.equal(cancelled.status, 'cancelled');
  });
});

test('件数の上限で止まった探索の候補は「一部未確認」とし、登録時の読み直しで最新の構成を返す', async () => {
  await fixture(async (root, put) => {
    await put('site/Dockerfile', 'FROM node:24');
    await put('site/a/package.json', JSON.stringify({ name: 'a' }));
    await put('site/b/package.json', JSON.stringify({ name: 'b' }));
    await put('other/package.json', JSON.stringify({ name: 'other' }));
    // root, other, and site are read (6 entries), then the limit stops the scan before site/a and site/b.
    const scan = newScan(root); await runScan(scan, undefined, undefined, { entries: 5 });
    assert.equal(scan.status, 'partial');
    const site = scan.candidates.find(c => c.name === 'site')!;
    assert.equal(site.incomplete, true); assert.equal(site.components.length, 0);
    // Progress: the limits used, what was found, and the folders left unread when it stopped.
    assert.deepEqual(scan.limits, { entries: 5, milliseconds: 1_200_000 });
    assert.equal(scan.found, 2); assert.equal(scan.pending, 2);
    // A rescan stops at the same place, so the import reads the candidate in full instead of rejecting it.
    const refreshed = await revalidateCandidate(root, site);
    assert.deepEqual(refreshed.components.map(c => c.name).sort(), ['a', 'b']);
    assert.equal(refreshed.incomplete, undefined);
    // A complete candidate that changed after the scan is still rejected.
    const full = newScan(root); await runScan(full);
    const complete = full.candidates.find(c => c.name === 'site')!;
    assert.equal(complete.incomplete, undefined);
    await put('site/c/package.json', JSON.stringify({ name: 'c' }));
    await assert.rejects(revalidateCandidate(root, complete));
  });
});

test('wp-content のテーマを登録時に読み直しても、サイト全体の探索と同じく中身を飛ばす', async () => {
  await fixture(async (root, put) => {
    await put('site/wp-includes/version.php', '<?php');
    await put('site/wp-content/plugins/index.php', '<?php // Silence is golden.');
    await put('site/wp-content/themes/mytheme/.git/HEAD', 'ref: refs/heads/main'); // A theme with its own repository is its own candidate.
    await put('site/wp-content/themes/mytheme/style.css', '/* Theme Name: My Theme */');
    await put('site/wp-content/themes/mytheme/package.json', JSON.stringify({ name: 'mytheme' }));
    await put('site/wp-content/themes/mytheme/assets/package.json', JSON.stringify({ name: 'assets' }));
    const scan = newScan(root); await runScan(scan);
    const theme = scan.candidates.find(c => c.path.endsWith('mytheme'));
    assert.ok(theme); assert.equal(theme.components.length, 0, 'theme internals are skipped');
    // Re-reading only the theme used to read its internals too, and every import of it was rejected as changed.
    const refreshed = await revalidateCandidate(root, theme);
    assert.equal(refreshed.fingerprint, theme.fingerprint);
  });
});

test('既存パスを識別し、独立したネストGitはworkspaceへ統合しない', async () => {
  await fixture(async (root, put) => {
    await put('parent/package.json', '{"name":"parent","workspaces":["apps/*"]}');
    await put('parent/apps/independent/package.json', '{"name":"independent"}');
    await put('parent/apps/independent/.git', 'gitdir: somewhere');
    const scan = newScan(root); await runScan(scan, new Set([join(root, 'parent')]));
    assert.equal(scan.candidates.length, 2); assert.ok(scan.candidates.find(c => c.name === 'parent')?.registered);
    assert.equal(scan.candidates.find(c => c.name === 'parent')?.components.length, 0);
  });
});

test('SAM・Flutter・Dockerの配下は1つのプロジェクトにまとめ、ネストGitだけを分ける', async () => {
  await fixture(async (root, put) => {
    await put('sam/template.yaml', 'Transform: AWS::Serverless-2016-10-31\nResources:\n  Fn:\n    Type: AWS::Serverless::Function');
    await put('sam/f01/requirements.txt', 'requests');
    await put('sam/layer/requirements.txt', 'numpy');
    await put('sam/layer/numpy-1.21.6.dist-info/METADATA', '');
    await put('sam/layer/numpy/core/setup.py', 'raise Exception("bundled")');
    await put('flutter/pubspec.yaml', 'name: clima\ndependencies:\n  flutter:\n    sdk: flutter');
    await put('flutter/android/build.gradle', '');
    await put('flutter/android/app/build.gradle', '');
    await put('compose/docker-compose.yml', 'services: {}');
    await put('compose/api/requirements.txt', 'fastapi');
    await put('repo/.git', 'gitdir: somewhere');
    await put('repo/tools/package.json', '{"name":"tools"}');
    await put('repo/vendor-lib/.git', 'gitdir: elsewhere');
    await put('repo/vendor-lib/sub/package.json', '{"name":"sub"}');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.status, 'completed');
    // repo and vendor-lib have only .git at their roots, so their apps become separate candidates.
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['clima', 'compose', 'sam', 'sub', 'tools']);
    const sam = scan.candidates.find(c => c.name === 'sam')!;
    assert.ok(sam.technologies.includes('AWS Lambda設定'));
    assert.ok(sam.technologies.includes('AWS SAM'));
    assert.deepEqual(sam.components.map(c => c.path).sort(), ['f01', 'layer']);
    assert.ok(sam.evidence.some(e => e.file === 'layer' && e.detail.includes('同梱')));
    assert.ok(!sam.evidence.some(e => e.file.includes('numpy')));
    const flutter = scan.candidates.find(c => c.name === 'clima')!;
    assert.ok(flutter.technologies.includes('Flutter')); assert.equal(flutter.components.length, 2);
    assert.equal(scan.candidates.find(c => c.name === 'compose')!.components.length, 1);
    assert.ok(scan.candidates.find(c => c.name === 'sub')!.evidence.some(e => e.detail.includes('「vendor-lib」')));
    await revalidateCandidate(root, sam);
  });
});

test('samconfig.tomlと別名のテンプレートからSAMアプリを検出する', async () => {
  await fixture(async (root, put) => {
    await put('app/samconfig.toml', [
      'version = 0.1',
      '[default.global.parameters]',
      'stack_name = "hello"',
      '[default.build.parameters]',
      'template_file = "infra/api.yaml"',
      '',
    ].join('\n'));
    await put('app/infra/api.yaml', [
      'Transform: AWS::Serverless-2016-10-31',
      'Resources:',
      '  ApiFn:',
      '    Type: AWS::Serverless::Function',
      '    Properties:',
      '      Runtime: python3.12',
      '      CodeUri: ../src/',
      '',
    ].join('\n'));
    await put('app/src/requirements.txt', 'boto3==1.34.0\n');
    await put('bare/samconfig.toml', 'version = 0.1\n[default.deploy.parameters]\nconfirm_changeset = true\n');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.status, 'completed');
    const app = scan.candidates.find(c => c.path.endsWith('/app'))!;
    assert.ok(app.technologies.includes('AWS SAM'));
    assert.ok(app.technologies.includes('AWS Lambda設定'));
    assert.ok(app.evidence.some(e => e.file === 'samconfig.toml' && e.detail.includes('infra/api.yaml')));
    assert.ok(app.evidence.some(e => e.file === 'infra/api.yaml'));
    assert.ok(app.components.some(c => c.path === 'src'));
    const bare = scan.candidates.find(c => c.path.endsWith('/bare'))!;
    assert.ok(bare.technologies.includes('AWS SAM'));
    assert.ok(bare.evidence.some(e => e.file === 'samconfig.toml'));
  });
});

test('直下が.gitだけのリポジトリは入れ物として扱い、中のアプリを個別の候補にする', async () => {
  await fixture(async (root, put) => {
    await put('gas/.git', 'gitdir: somewhere');
    await put('gas/rakumo/.clasp.json', '{"scriptId":"x"}');
    await put('gas/rakumo/src/appsscript.json', '{}');
    await put('gas/dev_archive/devicechecker/gapps.config.json', '{}');
    await put('gas/dev_archive/devicechecker/src/appsscript.json', '{}');
    await put('gas/dev_archive/payroll/.git', 'gitdir: payroll');
    await put('gas/dev_archive/payroll/package.json', '{"name":"payroll"}');
    await put('app/.git', 'gitdir: app');
    await put('app/package.json', '{"name":"app"}');
    await put('app/tools/package.json', '{"name":"tools"}');
    await put('empty-repo/.git', 'gitdir: empty');
    const scan = newScan(root); await runScan(scan);
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['app', 'devicechecker', 'empty-repo', 'payroll', 'rakumo']);
    const rakumo = scan.candidates.find(c => c.name === 'rakumo')!;
    assert.deepEqual(rakumo.components.map(c => c.path), ['src']);
    assert.ok(rakumo.evidence.some(e => e.file === join('..', '.git') && e.detail.includes('「gas」')));
    assert.ok(scan.candidates.find(c => c.name === 'devicechecker')!.evidence.some(e => e.file === join('..', '..', '.git')));
    assert.ok(!scan.candidates.find(c => c.name === 'payroll')!.evidence.some(e => e.detail.includes('「gas」')));
    assert.deepEqual(scan.candidates.find(c => c.name === 'app')!.components.map(c => c.name), ['tools']);
    await revalidateCandidate(root, rakumo);
  });
});

test('WordPressのコア・プラグイン内部・アップロードを探索せず、テーマを構成にまとめる', async () => {
  await fixture(async (root, put) => {
    await put('site/wp-load.php', '<?php');
    await put('site/wp-includes/sodium_compat/composer.json', '{"name":"core/lib"}');
    await put('site/wp-admin/x/package.json', '{"name":"admin"}');
    await put('site/wp-content/themes/mine/style.css', '/*\nTheme Name: Mine\n*/');
    await put('site/wp-content/plugins/big/composer.json', '{"name":"vendor/big"}');
    await put('site/wp-content/plugins/big/deep/package.json', '{"name":"inner"}');
    await put('site/wp-content/uploads/2024/package.json', '{"name":"upload"}');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.candidates.length, 1);
    const site = scan.candidates[0];
    assert.ok(site.technologies.includes('WordPress'));
    assert.deepEqual(site.components.map(c => c.path).sort(), ['wp-content/plugins/big', 'wp-content/themes/mine']);
  });
});

test('Apps Scriptを検出し、同じファイルの根拠は1行にまとめる', async () => {
  await fixture(async (root, put) => {
    await put('gas/.clasp.json', '{"scriptId":"secret-id","rootDir":"src"}');
    await put('web/package.json', JSON.stringify({ name: 'web', dependencies: { next: '15', react: '19' } }));
    const scan = newScan(root); await runScan(scan);
    const gas = scan.candidates.find(c => c.name === 'gas')!;
    assert.ok(gas.technologies.includes('Google Apps Script'));
    assert.ok(!JSON.stringify(gas).includes('secret-id'));
    const web = scan.candidates.find(c => c.name === 'web')!;
    assert.equal(web.evidence.filter(e => e.file === 'package.json').length, 1);
    assert.deepEqual(web.technologies, ['Node.js系', 'Next.js', 'React']);
  });
});

test('探索の深さは直近のプロジェクトから数える', async () => {
  await fixture(async (root, put) => {
    await put('a/b/c/app/package.json', '{"name":"app"}');
    await put('a/b/c/app/src/main/kotlin/x/package.json', '{"name":"inner"}');
    const scan = newScan(root); await runScan(scan, undefined, undefined, { depth: 5 });
    assert.equal(scan.status, 'completed');
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['app', 'inner']);
  });
});

test('追加は冪等で、重複する一括追加は全体をロールバックする', () => {
  const store = new Store(':memory:');
  try {
    const first = store.import('batch-one', [candidate()]);
    assert.deepEqual(store.import('batch-one', [candidate()]), first);
    assert.equal(store.projects().length, 1);
    assert.throws(() => store.import('batch-two', [candidate('/fixture/two'), candidate()]), CatalogError);
    assert.equal(store.projects().length, 1); assert.equal(store.previousImport('batch-two'), null);
  } finally { store.close(); }
});

test('編集競合を拒否し、アーカイブと復帰でデータを保持する', () => {
  const store = new Store(':memory:');
  try {
    const id = store.import('one', [candidate()]).projectIds[0]; const original = store.project(id);
    const maintained = store.edit(id, edit(original));
    assert.throws(() => store.edit(id, edit(original)), /別の画面/);
    // A reason is optional.
    const withoutReason = store.edit(id, { ...edit(maintained), lifecycle: 'archived' });
    assert.equal(withoutReason.lifecycle, 'archived'); assert.equal(withoutReason.archiveReason, '');
    const archived = store.edit(id, { ...edit(withoutReason), lifecycle: 'archived', archiveReason: '保留して記録を残す' });
    assert.ok(archived.archivedAt);
    const restored = store.edit(id, { ...edit(archived), lifecycle: 'on_hold', archiveReason: archived.archiveReason });
    assert.equal(restored.archivedAt, null); assert.equal(restored.archiveReason, archived.archiveReason);
    assert.equal(store.getHistory(id).length, 5);
  } finally { store.close(); }
});

test('SQLiteの再起動後も用途・タグ・アーカイブと履歴が残る', async () => {
  await fixture(async (root) => {
    const path = join(root, 'catalog.sqlite'); const first = new Store(path);
    const id = first.import('one', [candidate()]).projectIds[0];
    first.edit(id, { ...edit(first.project(id)), lifecycle: 'archived', archiveReason: '終了' }); first.close();
    const second = new Store(path);
    try { assert.equal(second.project(id).lifecycle, 'archived'); assert.deepEqual(second.project(id).tags, ['tool']); assert.equal(second.getHistory(id).length, 2); }
    finally { second.close(); }
  });
});

test('一括タグ追加の上限超過は全対象をロールバックする', () => {
  const store = new Store(':memory:');
  try {
    const [one, two] = store.import('batch', [candidate('/fixture/a'), candidate('/fixture/b')]).projectIds;
    store.addTags([two], Array.from({ length: 30 }, (_, i) => `tag-${i}`));
    assert.throws(() => store.addTags([one, two], ['extra']), /30個/);
    assert.deepEqual(store.project(one).tags, []);
    assert.equal(store.project(two).tags.length, 30);
  } finally { store.close(); }
});

function client(store: Store, pickFolder?: FolderPicker, openFolder?: FolderOpener, apps?: { pickApp?: AppPicker; openApp?: AppOpener }) {
  const api = createApi(store, 4310, pickFolder, openFolder, apps);
  let token = '';
  const call = async (path: string, body?: unknown, extra: Record<string, string> = {}, method = 'POST') => {
    const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : method,
      headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    if (path === '/session' && data.token) token = data.token;
    return { response, data };
  };
  return { api, call };
}

test('他サイト・不正Host・無効トークンからのAPI操作を拒否する', async () => {
  const store = new Store(':memory:');
  try {
    const { call } = client(store);
    assert.equal((await call('/projects')).response.status, 401);
    assert.equal((await call('/session', undefined, { origin: 'https://outside.example' })).response.status, 403);
    assert.equal((await call('/session', undefined, { host: 'outside.example' })).response.status, 403);
    assert.equal((await call('/session')).response.status, 200);
    assert.equal((await call('/projects')).response.status, 200);
    assert.equal((await call('/projects', undefined, { 'x-owndapp-client': '' })).response.status, 403);
  } finally { store.close(); }
});

test('APIで探索→追加→タグ整理→アーカイブが完結し、ソースを変更しない', async () => {
  await fixture(async (root, put) => {
    const source = '{"name":"personal-tool","dependencies":{"vue":"^3.5"}}';
    await put('app/package.json', source);
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const started = await call('/scans', { root }); assert.equal(started.response.status, 202);
      let scan: Scan = started.data.scan;
      for (let attempt = 0; attempt < 100 && scan.status === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan;
      }
      assert.equal(scan.status, 'completed');
      const added = await call('/imports', { id: 'request-one', scanId: scan.id, candidateIds: scan.candidates.map(c => c.id) });
      assert.equal(added.response.status, 201); const id = added.data.projectIds[0];
      assert.equal((await call('/projects/tags', { ids: [id], tags: ['整理', '個人'] })).response.status, 200);
      const project = store.project(id);
      assert.equal((await call(`/projects/${id}`, { ...edit(project), lifecycle: 'archived', archiveReason: '利用終了' }, {}, 'PATCH')).response.status, 200);
      assert.equal(store.project(id).lifecycle, 'archived');
      assert.equal(await readFile(join(root, 'app/package.json'), 'utf8'), source);
    } finally { store.close(); }
  });
});

test('Finderのフォルダ選択は、キャンセルを未選択として返し、同時に1つだけ開く', async () => {
  await fixture(async root => {
    const store = new Store(':memory:');
    try {
      const requested: (string | undefined)[] = [];
      let finish: (path: string | null) => void = () => {};
      const { call } = client(store, defaultPath => { requested.push(defaultPath); return new Promise(resolve => { finish = resolve; }); });
      await call('/session');
      const first = call('/folder-picker', { defaultPath: root });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await call('/folder-picker', {})).response.status, 409);
      finish(root);
      assert.deepEqual((await first).data, { path: root });
      const cancelled = call('/folder-picker', { defaultPath: '/no/such/folder' });
      await new Promise(resolve => setTimeout(resolve, 10));
      finish(null);
      assert.deepEqual((await cancelled).data, { path: null });
      assert.deepEqual(requested, [root, undefined]);
      assert.equal((await call('/scans')).data.scans.length, 0);
    } finally { store.close(); }
  });
});

test('Finderを開けない環境では、探索を始めずにエラーを返す', async () => {
  const store = new Store(':memory:');
  try {
    const { call } = client(store, async () => { throw new Error('unsupported'); });
    await call('/session');
    const result = await call('/folder-picker', {});
    assert.equal(result.response.status, 500); assert.match(result.data.error, /Finder/);
    assert.equal((await call('/folder-picker', {})).response.status, 500);
  } finally { store.close(); }
});

test('数百件の候補を1回で登録でき、構成が変わった候補があれば全体を戻して場所を示す', async () => {
  await fixture(async (root, put) => {
    for (let i = 0; i < 150; i++) await put(`apps/app-${i}/package.json`, JSON.stringify({ name: `app-${i}` }));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const scanAll = async () => {
        let scan: Scan = (await call('/scans', { root })).data.scan;
        for (let attempt = 0; attempt < 200 && scan.status === 'running'; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan;
        }
        assert.equal(scan.candidates.length, 30, 'the default response is one page');
        return (await call(`/scans/${scan.id}?limit=2000`)).data.scan as Scan;
      };
      const scan = await scanAll();
      assert.equal(scan.candidates.length, 150);
      await put('apps/app-7/package.json', '{"name":"changed"}');
      await put('apps/app-9/package.json', '{"name":"changed"}');
      const rejected = await call('/imports', { id: 'bulk-one', scanId: scan.id, candidateIds: scan.candidates.map(c => c.id) });
      assert.equal(rejected.response.status, 409);
      assert.match(rejected.data.error, /2件/); assert.match(rejected.data.error, /app-7/); assert.match(rejected.data.error, /app-9/);
      assert.equal(store.projects().length, 0);
      const rescanned = await scanAll();
      const added = await call('/imports', { id: 'bulk-two', scanId: rescanned.id, candidateIds: rescanned.candidates.map(c => c.id) });
      assert.equal(added.response.status, 201); assert.equal(added.data.projectIds.length, 150);
      assert.equal(store.projects().length, 150);
    } finally { store.close(); }
  });
});

test('WordPress本体のないバックアップも、サイト単位の1件にまとめる', async () => {
  await fixture(async (root, put) => {
    await put('ys-bk/20250921/sql/dump.sql', '-- dump');
    await put('ys-bk/20250921/wp-content/themes/mine/style.css', '/*\nTheme Name: Mine\n*/');
    await put('ys-bk/20250921/wp-content/themes/mine/package.json', '{"name":"mine-build"}');
    await put('ys-bk/20250921/wp-content/plugins/big/composer.json', '{"name":"vendor/big"}');
    await put('ys-bk/20250921/wp-content/plugins/big/vendor-src/deep/package.json', '{"name":"inner"}');
    await put('ys-bk/20250921/wp-content/uploads/2024/package.json', '{"name":"upload"}');
    await put('update/20260531/themes/child/style.css', '/*\nTheme Name: Child\n*/');
    await put('update/20260531/plugins/form/composer.json', '{"name":"vendor/form"}');
    await put('update/20260531/plugins/form/lib/package.json', '{"name":"lib"}');
    await put('wp_bk/20260629/theme-v3/style.css', '/*\nTheme Name: V3\n*/');
    await put('wp_bk/20260629/plugins/index.php', '<?php\n// Silence is golden.');
    await put('wp_bk/20260629/plugins/kit/composer.json', '{"name":"vendor/kit"}');
    await put('wp_bk/20260629/plugins/kit/third-party/a/b/composer.json', '{"name":"deep"}');
    await put('proto/wp-includes/sodium_compat/composer.json', '{"name":"core/lib"}');
    const scan = newScan(root); await runScan(scan);
    assert.equal(scan.status, 'completed');
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['20250921', '20260531', '20260629', 'proto']);
    assert.deepEqual(scan.candidates.find(c => c.name === '20260629')!.components.map(c => c.path).sort(), [join('plugins', 'kit'), 'theme-v3']);
    assert.equal(scan.candidates.find(c => c.name === 'proto')!.components.length, 0);
    const backup = scan.candidates.find(c => c.name === '20250921')!;
    assert.ok(backup.technologies.includes('WordPress'));
    assert.deepEqual(backup.components.map(c => c.path).sort(), ['wp-content/plugins/big', 'wp-content/themes/mine'].map(p => join(...p.split('/'))));
    const copy = scan.candidates.find(c => c.name === '20260531')!;
    assert.ok(copy.evidence.some(e => e.detail.includes('wp-contentの複製')));
    assert.deepEqual(copy.components.map(c => c.path).sort(), [join('plugins', 'form'), join('themes', 'child')]);
    await revalidateCandidate(root, backup);
  });
});

test('探索結果に、配下で登録済みのプロジェクト数を示す', async () => {
  await fixture(async (root, put) => {
    await put('site/wp-content/themes/a/style.css', '/*\nTheme Name: A\n*/');
    await put('site/wp-content/themes/b/style.css', '/*\nTheme Name: B\n*/');
    const store = new Store(':memory:');
    try {
      store.import('earlier', [candidate(join(root, 'site', 'wp-content', 'themes', 'a')), candidate(join(root, 'site', 'wp-content', 'themes', 'b'))]);
      const { call } = client(store); await call('/session');
      let scan: Scan = (await call('/scans', { root })).data.scan;
      for (let attempt = 0; attempt < 100 && scan.status === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan;
      }
      const site = scan.candidates.find(c => c.name === 'site')!;
      assert.equal(site.registered, false); assert.equal(site.registeredInside, 2);
    } finally { store.close(); }
  });
});

test('Finderで表示は登録済みプロジェクトの場所だけを開き、消えたフォルダは開かない', async () => {
  await fixture(async (root, put) => {
    await put('kept/package.json', '{"name":"kept"}');
    const store = new Store(':memory:');
    try {
      const [kept, gone] = store.import('reveal', [candidate(join(root, 'kept')), candidate(join(root, 'gone'))]).projectIds;
      const opened: string[] = [];
      const { call } = client(store, undefined, async path => { opened.push(path); });
      await call('/session');
      assert.equal((await call(`/projects/${kept}/reveal`, {})).response.status, 200);
      assert.deepEqual(opened, [join(root, 'kept')]);
      const missing = await call(`/projects/${gone}/reveal`, {});
      assert.equal(missing.response.status, 404); assert.match(missing.data.error, /フォルダが見つかりません/);
      assert.equal((await call('/projects/no-such-id/reveal', {})).response.status, 404);
      assert.deepEqual(opened, [join(root, 'kept')]);
      const failing = client(store, undefined, async () => { throw new Error('unsupported'); });
      await failing.call('/session');
      assert.equal((await failing.call(`/projects/${kept}/reveal`, {})).response.status, 500);
    } finally { store.close(); }
  });
});

test('見つからないフォルダを示し、存在するものは外さず、外した記録を残す', async () => {
  await fixture(async (root, put) => {
    await put('kept/package.json', '{"name":"kept"}');
    await put('moved/package.json', '{"name":"moved"}');
    const store = new Store(':memory:');
    try {
      const [kept, moved] = store.import('check', [candidate(join(root, 'kept')), candidate(join(root, 'moved'))]).projectIds;
      store.addTags([moved], ['移動前']);
      const { call } = client(store); await call('/session');
      let projects: Project[] = (await call('/projects')).data.projects;
      assert.deepEqual(projects.map(p => p.missing), [false, false]);
      await rm(join(root, 'moved'), { recursive: true });
      projects = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === moved)!.missing, true); assert.equal(projects.find(p => p.id === kept)!.missing, false);
      const refused = await call('/projects/remove-missing', { ids: [moved, kept] });
      assert.equal(refused.response.status, 409); assert.match(refused.data.error, /kept/);
      assert.equal(store.projects().length, 2);
      const done = await call('/projects/remove-missing', { ids: [moved] });
      assert.equal(done.response.status, 200); assert.equal(done.data.removed, 1);
      assert.deepEqual(store.projects().map(p => p.id), [kept]);
      assert.equal((await call(`/projects/${moved}/history`)).response.status, 404);
      const [record] = store.removals();
      const saved = JSON.parse(record.payload);
      assert.equal(record.path, join(root, 'moved')); assert.deepEqual(saved.project.tags, ['移動前']);
      assert.deepEqual(saved.history.map((h: { action: string }) => h.action), ['registered', 'tags_added']);
      assert.equal(await readFile(join(root, 'kept/package.json'), 'utf8'), '{"name":"kept"}');
    } finally { store.close(); }
  });
});

test('除外したフォルダはサブフォルダを含めて探索せず、Componentにも含めない', async () => {
  await fixture(async (root, put) => {
    await put('keep/package.json', JSON.stringify({ name: 'keep' }));
    await put('archive/old/package.json', JSON.stringify({ name: 'old' }));
    await put('archive/old/deep/nested/go.mod', 'module example.com/nested');
    await put('site/Dockerfile', 'FROM node:24');
    await put('site/legacy/package.json', JSON.stringify({ name: 'legacy' }));
    const exclusions = [join(root, 'archive'), join(root, 'site/legacy')];
    const scan = newScan(root); await runScan(scan, undefined, undefined, { exclusions });
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['keep', 'site']);
    const site = scan.candidates.find(c => c.name === 'site')!;
    assert.equal(site.components.length, 0);
    await revalidateCandidate(root, site, exclusions);
    await assert.rejects(revalidateCandidate(root, site));
    const inside = newScan(join(root, 'archive/old')); await runScan(inside, undefined, undefined, { exclusions });
    assert.equal(inside.candidates.length, 0);
  });
});

test('APIで除外フォルダを保存し、探索・既存結果・登録に反映する', async () => {
  await fixture(async (root, put) => {
    await put('a/package.json', JSON.stringify({ name: 'a' }));
    await put('b/package.json', JSON.stringify({ name: 'b' }));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const wait = async (scan: Scan) => {
        for (let attempt = 0; attempt < 100 && scan.status === 'running'; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan;
        }
        return scan;
      };
      assert.equal((await call('/exclusions', { path: '/no/such/folder' })).response.status, 400);
      assert.deepEqual((await call('/exclusions', { path: join(root, 'a') })).data.exclusions, [join(root, 'a')]);
      // Several at once, all or none: a missing folder adds nothing.
      assert.equal((await call('/exclusions', { paths: [join(root, 'b'), '/no/such/folder'] })).response.status, 400);
      assert.deepEqual((await call('/exclusions')).data.exclusions, [join(root, 'a')]);
      let scan = await wait((await call('/scans', { root })).data.scan);
      assert.deepEqual(scan.candidates.map(c => c.name), ['b']);
      assert.deepEqual(scan.exclusions, [join(root, 'a')]);
      assert.equal((await call('/scans', { root: join(root, 'a') })).response.status, 400);
      // Excluding after a scan hides the candidate at once and blocks its import.
      const b = scan.candidates[0];
      await call('/exclusions', { path: join(root, 'b') });
      assert.equal((await call(`/scans/${scan.id}`)).data.scan.candidates.length, 0);
      assert.equal((await call('/imports', { id: 'excluded', scanId: scan.id, candidateIds: [b.id] })).response.status, 409);
      assert.deepEqual((await call('/exclusions/remove', { path: join(root, 'b') })).data.exclusions, [join(root, 'a')]);
      assert.equal((await call('/imports', { id: 'restored', scanId: scan.id, candidateIds: [b.id] })).response.status, 201);
      assert.deepEqual((await call('/exclusions')).data.exclusions, [join(root, 'a')]);
    } finally { store.close(); }
  });
});

test('除外設定のフォルダにある登録済みプロジェクトを示し、除外の中にあるものだけ外す', async () => {
  await fixture(async (root, put) => {
    await put('old/app/package.json', JSON.stringify({ name: 'old-app' }));
    await put('keep/package.json', JSON.stringify({ name: 'keep' }));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      let scan: Scan = (await call('/scans', { root })).data.scan;
      for (let attempt = 0; attempt < 100 && scan.status === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan;
      }
      await call('/imports', { id: 'both', scanId: scan.id, candidateIds: scan.candidates.map(c => c.id) });
      assert.equal((await call('/exclusions', { path: join(root, 'old') })).data.registeredInside, 1);
      const projects: Project[] = (await call('/projects')).data.projects;
      const old = projects.find(p => p.name === 'old-app')!; const keep = projects.find(p => p.name === 'keep')!;
      assert.equal(old.excluded, true); assert.equal(keep.excluded, false);
      assert.equal((await call('/projects/remove-excluded', { ids: [old.id, keep.id] })).response.status, 409);
      assert.equal(store.projects().length, 2);
      const removed = await call('/projects/remove-excluded', { ids: [old.id] });
      assert.equal(removed.data.removed, 1);
      assert.deepEqual(store.projects().map(p => p.name), ['keep']);
      assert.match(store.removals()[0].payload, /除外設定のフォルダにあるため/);
      assert.equal(await readFile(join(root, 'old/app/package.json'), 'utf8'), JSON.stringify({ name: 'old-app' }));
    } finally { store.close(); }
  });
});

test('一般的な管理状態をすべて保存でき、未知の状態は拒否する', () => {
  const store = new Store(':memory:');
  try {
    const { projectIds: [id] } = store.import('statuses', [candidate()]);
    let project = store.project(id);
    assert.equal(project.lifecycle, 'untriaged');
    for (const lifecycle of ['planning', 'active', 'testing', 'maintained', 'on_hold', 'completed', 'cancelled'] as const) {
      project = store.edit(id, { ...edit(project), lifecycle });
      assert.equal(project.lifecycle, lifecycle); assert.equal(project.archivedAt, null);
    }
    assert.throws(() => store.edit(id, { ...edit(project), lifecycle: 'toString' as any }), /管理状態/);
    assert.throws(() => store.edit(id, { ...edit(project), lifecycle: 'done' as any }), /管理状態/);
  } finally { store.close(); }
});

test('管理状態を一括で変更し、アーカイブには理由を求め、失敗時は全件を戻す', async () => {
  const store = new Store(':memory:');
  try {
    const { projectIds: [one, two] } = store.import('bulk-lifecycle', [{ ...candidate('/fixture/one'), id: 'a' }, { ...candidate('/fixture/two'), id: 'b' }]);
    assert.equal(store.setLifecycle([one, two], 'active'), 2);
    assert.deepEqual(store.projects().map(p => p.lifecycle), ['active', 'active']);
    assert.throws(() => store.setLifecycle([one, 'missing-id'], 'completed'), /見つかりません/);
    assert.equal(store.project(one).lifecycle, 'active');
    store.setLifecycle([one, two], 'archived', '公開終了');
    const archived = store.project(one);
    assert.equal(archived.archiveReason, '公開終了'); assert.ok(archived.archivedAt);
    store.setLifecycle([one], 'maintained');
    assert.equal(store.project(one).archivedAt, null); assert.equal(store.project(two).lifecycle, 'archived');
    assert.match(JSON.stringify(store.getHistory(one)), /lifecycle_changed/);
    // An open detail form must notice the bulk change instead of overwriting it.
    assert.throws(() => store.edit(one, edit(archived)), /別の画面/);

    const { call } = client(store); await call('/session');
    assert.equal((await call('/projects/lifecycle', { ids: [one], lifecycle: 'done' })).response.status, 400);
    assert.equal((await call('/projects/lifecycle', { ids: [], lifecycle: 'active' })).response.status, 400);
    const result = await call('/projects/lifecycle', { ids: [one, two], lifecycle: 'completed' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.projects.map((p: Project) => p.lifecycle), ['completed', 'completed']);
  } finally { store.close(); }
});

test('エディタ・ターミナルを登録し、登録済みプロジェクトのフォルダだけをそのアプリで開く', async () => {
  await fixture(async (root, put) => {
    await put('Apps/Cursor.app/Contents/Info.plist', '<plist/>');
    await put('Apps/Ghostty.app/Contents/Info.plist', '<plist/>');
    await put('Apps/not-an-app/readme.txt', '');
    await put('project/package.json', JSON.stringify({ name: 'project' }));
    const store = new Store(':memory:');
    try {
      let chosen: string | null = join(root, 'Apps/Cursor.app');
      const prompts: string[] = []; const opened: string[][] = [];
      const { call } = client(store, undefined, undefined, {
        pickApp: async prompt => { prompts.push(prompt); return chosen; },
        openApp: async (app, path) => { opened.push([app, path]); },
      });
      await call('/session');
      assert.deepEqual((await call('/apps')).data.apps, { editor: null, terminal: null });
      const { projectIds: [id] } = store.import('open-with', [{ ...candidate(join(root, 'project')), id: 'p' }]);
      assert.equal((await call(`/projects/${id}/open`, { role: 'editor' })).response.status, 400);
      assert.deepEqual((await call('/apps/pick', { role: 'editor' })).data.apps.editor, { name: 'Cursor', path: join(root, 'Apps/Cursor.app') });
      assert.match(prompts[0], /エディタ/);
      chosen = join(root, 'Apps/Ghostty.app'); await call('/apps/pick', { role: 'terminal' });
      chosen = join(root, 'Apps/not-an-app');
      assert.equal((await call('/apps/pick', { role: 'terminal' })).response.status, 400);
      chosen = null;
      assert.equal((await call('/apps/pick', { role: 'terminal' })).data.cancelled, true);
      assert.equal(store.apps().terminal?.name, 'Ghostty');
      assert.equal((await call('/apps/pick', { role: 'browser' })).response.status, 400);
      assert.equal((await call(`/projects/${id}/open`, { role: 'editor' })).response.status, 200);
      assert.equal((await call(`/projects/${id}/open`, { role: 'terminal' })).response.status, 200);
      assert.deepEqual(opened, [[join(root, 'Apps/Cursor.app'), join(root, 'project')], [join(root, 'Apps/Ghostty.app'), join(root, 'project')]]);
      // A registered app that was deleted, or a moved project, is reported instead of opened.
      await rm(join(root, 'Apps/Cursor.app'), { recursive: true });
      assert.equal((await call(`/projects/${id}/open`, { role: 'editor' })).response.status, 404);
      await rm(join(root, 'project'), { recursive: true });
      assert.equal((await call(`/projects/${id}/open`, { role: 'terminal' })).response.status, 404);
      assert.equal((await call('/projects/unknown/open', { role: 'terminal' })).response.status, 404);
      assert.equal(opened.length, 2);
      assert.equal((await call('/apps/clear', { role: 'terminal' })).data.apps.terminal, null);
    } finally { store.close(); }
  });
});

test('依存情報を読み、パッケージ名・版で横断検索し、読み直しや外したプロジェクトで古い行を残さない', async () => {
  await fixture(async (root, put) => {
    const lock = (deps: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: deps },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])) } });
    await put('web/package.json', JSON.stringify({ dependencies: { next: '15.1.0' } }));
    await put('web/package-lock.json', lock({ next: '15.1.0' }));
    await put('old/package.json', JSON.stringify({ dependencies: { next: '13.0.0' } }));
    await put('old/package-lock.json', lock({ next: '13.0.0' }));
    await put('py/pyproject.toml', '[project]\nname="py"');
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const { projectIds } = store.import('deps', ['web', 'old', 'py', 'gone'].map(name => ({ ...candidate(join(root, name)), id: name })));
      const [web, old, py, gone] = projectIds;
      const lockBefore = await readFile(join(root, 'web/package-lock.json'), 'utf8');
      assert.equal((await call('/dependencies/search?name=next')).data.matches.length, 0);
      const read = await call('/dependencies/read', { ids: [web, old, py, gone] });
      assert.deepEqual(read.data.results.map((r: any) => r.status), ['complete', 'complete', 'no-lock', 'missing']);
      assert.equal(await readFile(join(root, 'web/package-lock.json'), 'utf8'), lockBefore);
      const all = (await call('/dependencies/search?name=NEXT')).data;
      assert.deepEqual(all.matches.map((m: any) => m.project.id).sort(), [old, web].sort());
      assert.deepEqual(all.coverage, { read: 3, withLock: 2, total: 4, unsupported: 0 });
      const exact = (await call('/dependencies/search?name=next&version=13.0.0')).data.matches;
      assert.deepEqual(exact.map((m: any) => [m.project.id, m.dependencies[0].version, m.dependencies[0].direct]), [[old, '13.0.0', true]]);
      assert.equal((await call('/dependencies/search?name=')).response.status, 400);
      assert.equal((await call('/dependencies/search?name=next&match=bad')).response.status, 400);
      assert.deepEqual((await call('/dependencies/search?name=EXT&match=contains')).data.matches.map((m: any) => m.project.id).sort(), [old, web].sort());
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === web)!.dependencyStatus, 'complete');
      assert.equal(projects.find(p => p.id === gone)!.dependencyStatus, undefined);
      let detail = (await call(`/projects/${web}/dependencies`)).data;
      assert.equal(detail.snapshot.direct, 1); assert.equal(detail.changed, false);
      // The project's lockfile changes: the detail says so, and reading again replaces the old rows.
      await put('web/package.json', JSON.stringify({ dependencies: { next: '15.2.0' } }));
      await put('web/package-lock.json', lock({ next: '15.2.0' }));
      assert.equal((await call(`/projects/${web}/dependencies`)).data.changed, true);
      await call('/dependencies/read', { ids: [web] });
      detail = (await call(`/projects/${web}/dependencies`)).data;
      assert.deepEqual(detail.dependencies.map((d: any) => d.version), ['15.2.0']); assert.equal(detail.changed, false);
      assert.equal((await call('/dependencies/search?name=next&version=15.1.0')).data.matches.length, 0);
      assert.match(JSON.stringify(store.getHistory(web)), /dependencies_read/);
      // Removing a project drops its dependency rows; the removal record keeps only when they were read.
      await rm(join(root, 'old'), { recursive: true });
      assert.equal((await call('/projects/remove-missing', { ids: [old] })).data.removed, 1);
      assert.deepEqual((await call('/dependencies/search?name=next')).data.matches.map((m: any) => m.project.id), [web]);
      assert.ok(JSON.parse(store.removals()[0].payload).dependenciesReadAt);
      assert.equal((await call('/dependencies/read', { ids: [] })).response.status, 400);
    } finally { store.close(); }
  });
});

test('記録されている依存パッケージを、使っているプロジェクトが多い順に一覧・絞り込みできる', async () => {
  await fixture(async (root, put) => {
    const lock = (deps: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [Object.keys(deps)[0]]: Object.values(deps)[0] } },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])) } });
    await put('a/package.json', JSON.stringify({ dependencies: { react: '19.0.0' } }));
    await put('a/package-lock.json', lock({ react: '19.0.0', 'scheduler': '0.25.0', 'my_pkg': '1.0.0' }));
    await put('b/package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    await put('b/package-lock.json', lock({ next: '15.0.0', react: '18.3.1' }));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const { projectIds } = store.import('pkgs', ['a', 'b'].map(name => ({ ...candidate(join(root, name)), id: name })));
      assert.deepEqual((await call('/dependencies/packages')).data, { total: 0, packages: [] });
      await call('/dependencies/read', { ids: projectIds });
      const all = (await call('/dependencies/packages')).data;
      assert.equal(all.total, 4);
      assert.deepEqual(all.packages[0], { ecosystem: 'npm', name: 'react', projects: 2, directProjects: 1, versions: all.packages[0].versions });
      assert.deepEqual([...all.packages[0].versions].sort(), ['18.3.1', '19.0.0']);
      assert.deepEqual((await call('/dependencies/packages?q=NEXT')).data.packages.map((p: any) => p.name), ['next']);
      // LIKE wildcards in the filter are taken literally.
      assert.deepEqual((await call('/dependencies/packages?q=_')).data.packages.map((p: any) => p.name), ['my_pkg']);
      assert.deepEqual((await call('/dependencies/packages?q=%25')).data.packages, []);
      assert.equal((await call('/dependencies/packages?limit=1')).data.packages.length, 1);
      // Packages of a removed project are no longer listed.
      store.remove([projectIds[1]], 'test');
      assert.deepEqual((await call('/dependencies/packages?q=next')).data, { total: 0, packages: [] });
    } finally { store.close(); }
  });
});

test('登録したプロジェクトの依存情報を自動で読み取り、アーカイブ以外をまとめて読み取れる', async () => {
  await fixture(async (root, put) => {
    const lock = (name: string, version: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [name]: version } },
      [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } } });
    await put('web/package.json', JSON.stringify({ name: 'web', dependencies: { vue: '3.5.13' } }));
    await put('web/package-lock.json', lock('vue', '3.5.13'));
    await put('old/package.json', JSON.stringify({ name: 'old', dependencies: { jquery: '1.12.4' } }));
    await put('old/package-lock.json', lock('jquery', '1.12.4'));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const wait = async () => { for (let i = 0; i < 200 && (await call('/dependencies/progress')).data.running; i++) await new Promise(r => setTimeout(r, 5)); };
      let scan: Scan = (await call('/scans', { root })).data.scan;
      for (let i = 0; i < 100 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan; }
      const added = await call('/imports', { id: 'auto-read', scanId: scan.id, candidateIds: scan.candidates.map(c => c.id) });
      assert.equal(added.response.status, 201);
      await wait();
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.deepEqual(projects.map(p => p.dependencyStatus), ['complete', 'complete'], 'registered projects are read without any extra step');
      assert.equal((await call('/dependencies/search?name=vue')).data.matches.length, 1);
      assert.deepEqual((await call('/dependencies/progress')).data, { running: false, done: 0, total: 0 });
      // Read everything except archived projects. The archived one keeps its earlier read untouched.
      const old = projects.find(p => p.name === 'old')!; const web = projects.find(p => p.name === 'web')!;
      store.setLifecycle([old.id], 'archived', '公開終了');
      const before = store.dependencySnapshots().get(old.id)!.readAt;
      await new Promise(r => setTimeout(r, 5));
      const all = await call('/dependencies/read-all', {});
      assert.equal(all.data.queued, 1);
      await wait();
      assert.equal(store.dependencySnapshots().get(old.id)!.readAt, before);
      assert.notEqual(store.dependencySnapshots().get(web.id)!.readAt, projects.find(p => p.id === web.id)!.dependenciesReadAt);
    } finally { store.close(); }
  });
});

test('登録時に用途が空ならREADMEから入れ、書いた用途は上書きせず、編集すると自動入力の印が消える', async () => {
  await fixture(async (root, put) => {
    await put('web/package.json', JSON.stringify({ name: 'web' }));
    await put('web/README.md', '# web\n\n社内のお知らせと予定をまとめて表示するポータル。');
    await put('cli/package.json', JSON.stringify({ name: 'cli', description: 'Exports Slack messages to CSV' }));
    await put('bare/package.json', JSON.stringify({ name: 'bare' }));
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const wait = async () => { for (let i = 0; i < 200 && (await call('/dependencies/progress')).data.running; i++) await new Promise(r => setTimeout(r, 5)); };
      let scan: Scan = (await call('/scans', { root })).data.scan;
      for (let i = 0; i < 100 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan; }
      await call('/imports', { id: 'purposes', scanId: scan.id, candidateIds: scan.candidates.map(c => c.id) });
      await wait();
      const byName = (name: string) => store.projects().find(p => p.name === name)!;
      assert.equal(byName('web').purpose, '社内のお知らせと予定をまとめて表示するポータル。');
      assert.equal(byName('web').purposeSource, 'README.md');
      assert.equal(byName('cli').purpose, 'Exports Slack messages to CSV');
      assert.equal(byName('cli').purposeSource, 'package.json');
      assert.equal(byName('bare').purpose, '');
      assert.match(JSON.stringify(store.getHistory(byName('web').id)), /purpose_filled/);
      // Editing the purpose makes it the user's own; filling again never replaces it.
      const web = byName('web');
      store.edit(web.id, { revision: web.revision, name: web.name, purpose: '自分で書いた用途', tags: [], notes: '', lifecycle: 'untriaged', archiveReason: '' });
      assert.equal(byName('web').purposeSource, undefined);
      await put('bare/README.md', '# bare\n\n後から書いたREADMEの説明文。');
      assert.deepEqual((await call(`/projects/${byName('bare').id}/purpose-suggestion`)).data.suggestion, { text: '後から書いたREADMEの説明文。', source: 'README.md' });
      assert.equal(byName('bare').purpose, '', 'a suggestion alone changes nothing');
      assert.deepEqual((await call('/purposes/fill', {})).data, { checked: 1, filled: 1 });
      assert.equal(byName('bare').purpose, '後から書いたREADMEの説明文。');
      assert.equal(byName('web').purpose, '自分で書いた用途');
      assert.deepEqual((await call('/purposes/fill', {})).data, { checked: 0, filled: 0 });
    } finally { store.close(); }
  });
});

test('アーカイブする直前の管理状態を記録し、外すときに戻せるようにする', () => {
  const store = new Store(':memory:');
  try {
    const { projectIds: [one, two] } = store.import('archive-from', [{ ...candidate('/fixture/one'), id: 'a' }, { ...candidate('/fixture/two'), id: 'b' }]);
    let project = store.edit(one, { ...edit(store.project(one)), lifecycle: 'active' });
    project = store.edit(one, { ...edit(project), lifecycle: 'archived', archiveReason: '公開終了' });
    assert.equal(project.archivedFrom, 'active');
    // Saving again while archived keeps what it was before, not "archived".
    project = store.edit(one, { ...edit(project), lifecycle: 'archived', archiveReason: '公開終了（追記）' });
    assert.equal(project.archivedFrom, 'active');
    project = store.edit(one, { ...edit(project), lifecycle: 'active', archiveReason: project.archiveReason });
    assert.equal(project.archivedFrom, undefined);
    store.setLifecycle([two], 'completed');
    store.setLifecycle([two], 'archived', 'まとめて');
    assert.equal(store.project(two).archivedFrom, 'completed');
    store.setLifecycle([two], 'on_hold');
    assert.equal(store.project(two).archivedFrom, undefined);
  } finally { store.close(); }
});

test('探索したフォルダを登録し、最後の探索の要約を返し、古い探索結果も開ける', async () => {
  await fixture(async (root, put) => {
    await put('a/package.json', JSON.stringify({ name: 'a' }));
    await put('b/package.json', JSON.stringify({ name: 'b' }));
    const path = join(root, 'catalog.sqlite');
    let store = new Store(path);
    try {
      const { call } = client(store); await call('/session');
      assert.deepEqual((await call('/scan-roots')).data.roots, []);
      let scan: Scan = (await call('/scans', { root })).data.scan;
      for (let i = 0; i < 100 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 10)); scan = (await call(`/scans/${scan.id}`)).data.scan; }
      let [summary] = (await call('/scan-roots')).data.roots;
      assert.equal(summary.path, root);
      assert.deepEqual({ ...summary.lastScan, startedAt: undefined, endedAt: undefined }, { id: scan.id, status: 'completed', candidates: 2, newCandidates: 2, startedAt: undefined, endedAt: undefined });
      await call('/imports', { id: 'one', scanId: scan.id, candidateIds: [scan.candidates[0].id] });
      [summary] = (await call('/scan-roots')).data.roots;
      assert.equal(summary.lastScan.newCandidates, 1, 'the summary follows registrations');
      // Scanning again keeps one entry for the folder.
      let again: Scan = (await call('/scans', { root })).data.scan;
      for (let i = 0; i < 100 && again.status === 'running'; i++) { await new Promise(r => setTimeout(r, 10)); again = (await call(`/scans/${again.id}`)).data.scan; }
      for (let i = 0; i < 200 && (await call('/dependencies/progress')).data.running; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal((await call('/scan-roots')).data.roots.length, 1);
      assert.deepEqual((await call('/scan-roots/remove', { path: root })).data.roots, []);
    } finally { store.close(); }
    // A catalog from before scan folders existed: its scanned roots become registered once, and old scans can still be opened.
    store = new Store(path);
    try {
      store.db.exec("DELETE FROM scan_roots; DELETE FROM settings WHERE key='scanRoots.seeded'");
      const old = { ...newScan(root), status: 'completed' as const };
      store.saveScan(old);
      for (let i = 0; i < 10; i++) store.saveScan({ ...newScan(join(root, 'a')), status: 'completed' });
    } finally { store.close(); }
    store = new Store(path);
    try {
      assert.deepEqual(store.scanRoots().map(r => r.path).sort(), [root, join(root, 'a')].sort());
      store.removeScanRoot(join(root, 'a'));
      const { call } = client(store); await call('/session');
      const oldest = store.latestScan(root)!;
      assert.equal((await call(`/scans/${oldest.id}`)).response.status, 200, 'a scan outside the ten loaded at start is read from the database');
      store.close(); store = new Store(path);
      assert.deepEqual(store.scanRoots().map(r => r.path), [root], 'seeding happens only once');
    } finally { store.close(); }
  });
});

test('Claude Code の作業用コピー（.claude/worktrees）は既定で探索せず、登録済みのものは除外扱いで外せる', async () => {
  await fixture(async (root, put) => {
    await put('app/package.json', JSON.stringify({ name: 'app' }));
    await put('app/.git/HEAD', 'ref: refs/heads/main');
    await put('app/.claude/worktrees/sleepy-cohen/package.json', JSON.stringify({ name: 'app' }));
    await put('app/.claude/worktrees/sleepy-cohen/.git', 'gitdir: ../../../.git/worktrees/sleepy-cohen');
    await put('app/.claude/settings.json', '{}');
    await put('other/claude/worktrees/real/package.json', JSON.stringify({ name: 'real' }));
    const scan = newScan(root); await runScan(scan);
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['app', 'real'], 'only .claude/worktrees is skipped');
    assert.equal(scan.candidates.find(c => c.name === 'app')!.components.length, 0);
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      // Registered before the built-in exclusion existed.
      const { projectIds: [worktree, app] } = store.import('wt', [
        { ...candidate(join(root, 'app/.claude/worktrees/sleepy-cohen')), id: 'wt' }, { ...candidate(join(root, 'app')), id: 'app' }]);
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === worktree)!.excluded, true);
      assert.equal(projects.find(p => p.id === app)!.excluded, false);
      assert.equal((await call('/projects/remove-excluded', { ids: [worktree] })).data.removed, 1);
      assert.equal((await call('/scans', { root: join(root, 'app/.claude/worktrees/sleepy-cohen') })).response.status, 400);
    } finally { store.close(); }
  });
});


test('Swiftの.build内の取得依存を探索せず、登録済みコピーは除外扱いで記録を保つ', async () => {
  await fixture(async (root, put) => {
    await put('Core/Package.swift', '// swift-tools-version: 6.0');
    await put('Core/.build/checkouts/FeedKit/Package.swift', '// swift-tools-version: 6.0');
    await put('Core/.build/checkouts/FeedKit/.git/HEAD', 'ref: refs/heads/main');
    await put('Core/.build/index-build/checkouts/FeedKit/Package.swift', '// swift-tools-version: 6.0');
    await put('own-build/Package.swift', '// swift-tools-version: 6.0');
    const scan = newScan(root); await runScan(scan);
    assert.deepEqual(scan.candidates.map(c => c.name).sort(), ['Core', 'own-build']);
    const store = new Store(':memory:');
    try {
      const { call } = client(store); await call('/session');
      const { projectIds: [dependency, core] } = store.import('swift-generated', [
        { ...candidate(join(root, 'Core/.build/checkouts/FeedKit')), id: 'dependency' },
        { ...candidate(join(root, 'Core')), id: 'core' },
      ]);
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === dependency)!.excluded, true);
      assert.equal(projects.find(p => p.id === core)!.excluded, false);
      assert.equal(store.projects().length, 2, 'the new exclusion does not remove records by itself');
      assert.equal((await call('/scans', { root: join(root, 'Core/.build') })).response.status, 400);
      assert.equal((await call('/projects/remove-excluded', { ids: [dependency] })).data.removed, 1);
      assert.equal(store.removals().length, 1);
    } finally { store.close(); }
  });
});

test('Guard APIは登録先だけを変更し、競合・除外・他サイトを拒否する', async () => {
  await fixture(async (root, put) => {
    await put('package.json', '{"name":"guard-api"}');
    const store = new Store(':memory:');
    try {
      const [id] = store.import('guard-api', [candidate(root)]).projectIds;
      const { call } = client(store);
      assert.equal((await call(`/projects/${id}/guard`, {})).response.status, 401);
      await call('/session');
      const initial = await call(`/projects/${id}/guard`);
      assert.equal(initial.data.state, 'available');
      assert.equal((await call('/projects/nonexistent/guard')).response.status, 404);
      assert.equal((await call(`/projects/${id}/guard`, { revision: initial.data.revision }, { origin: 'https://example.com' })).response.status, 403);
      await put('.npmrc', '# changed after preview\n');
      assert.equal((await call(`/projects/${id}/guard`, { revision: initial.data.revision })).response.status, 409);
      const fresh = await call(`/projects/${id}/guard`);
      store.addExclusions([root]);
      assert.equal((await call(`/projects/${id}/guard`, { revision: fresh.data.revision })).response.status, 409);
      assert.equal(await readFile(join(root, '.npmrc'), 'utf8'), '# changed after preview\n');
    } finally { store.close(); }
  });
});

test('DB探索は一時停止・再開と候補ページ取得に対応し、探索記録の削除でも登録情報を残す', async () => {
  await fixture(async (root, put) => {
    for (let i = 0; i < 72; i++) await put(`tool-${String(i).padStart(3, '0')}/package.json`, JSON.stringify({ name: `tool-${String(i).padStart(3, '0')}` }));
    const store = new Store(':memory:'); const { api, call } = client(store);
    try {
      await call('/session');
      let scan: Scan = (await call('/scans', { root })).data.scan;
      assert.equal(scan.persistent, true);
      await call(`/scans/${scan.id}/pause`, {});
      for (let i = 0; i < 1000 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 5)); scan = (await call(`/scans/${scan.id}?limit=30`)).data.scan; }
      assert.ok(['paused', 'completed'].includes(scan.status));
      if (scan.status === 'paused') {
        assert.ok((scan.pending ?? 0) > 0);
        const resumed = await call(`/scans/${scan.id}/resume`, {}); assert.equal(resumed.response.status, 202); scan = resumed.data.scan;
      }
      for (let i = 0; i < 1000 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 5)); scan = (await call(`/scans/${scan.id}?limit=30&filter=new`)).data.scan; }
      assert.equal(scan.status, 'completed'); assert.equal(scan.candidateCount, 72); assert.equal(scan.candidates.length, 30);
      const next: Scan = (await call(`/scans/${scan.id}?limit=30&offset=30&filter=new`)).data.scan;
      assert.equal(next.candidates.length, 30); assert.ok(!next.candidates.some(c => scan.candidates.some(first => first.id === c.id)));
      const selected = await call(`/scans/${scan.id}/selection?filter=new`); assert.equal(selected.data.ids.length, 72);
      const summary = store.scan(scan.id)!; assert.equal(summary.candidates.length, 0, 'summary must not embed all results');
      const filtered = await call(`/scans/${scan.id}?limit=30&q=tool-071`); assert.equal(filtered.data.scan.filteredCount, 1);
      const id = scan.candidates[0].id;
      const imported = await call('/imports', { id: 'durable-import', scanId: scan.id, candidateIds: [id] }); assert.equal(imported.response.status, 201);
      const projectId = imported.data.projectIds[0]; assert.ok(store.project(projectId));
      const removed = await call(`/scans/${scan.id}/remove`, {}); assert.equal(removed.response.status, 200);
      assert.equal((await call(`/scans/${scan.id}`)).response.status, 404); assert.ok(store.project(projectId));
    } finally { await api.shutdownScans(); store.close(); }
  });
});

test('旧形式の探索も候補登録・問題の全件表示・履歴のページ表示・記録削除を利用できる', async () => {
  await fixture(async (root, put) => {
    await put('package.json', '{"name":"legacy-tool"}');
    const original = newScan(root); await runScan(original);
    original.issues = Array.from({ length: 205 }, (_, i) => ({ path: join(root, `issue-${i}`), message: `test issue ${i}` }));
    const store = new Store(':memory:');
    store.saveScan(original);
    for (let i = 0; i < 24; i++) store.saveScan({ ...original, id: `legacy-history-${i}` });
    const { api, call } = client(store);
    try {
      await call('/session');
      const secondPage = await call(`/scans/${original.id}/issues?offset=100`);
      assert.equal(secondPage.data.total, 205); assert.equal(secondPage.data.issues.length, 100); assert.equal(secondPage.data.issues[0].message, 'test issue 100');
      const history = await call('/scan-history?offset=20'); assert.equal(history.data.total, 25); assert.equal(history.data.items.length, 5);
      const added = await call('/imports', { id: 'legacy-page-import', scanId: original.id, candidateIds: [original.candidates[0].id] });
      assert.equal(added.response.status, 201);
      assert.equal((await call(`/scans/${original.id}/remove`, {})).response.status, 200);
      assert.equal(store.projects().length, 1);
    } finally { await api.shutdownScans(); store.close(); }
  });
});

test('フォルダパスはホーム省略形を解決し、相対パスやファイルをフォルダとして受け付けない', async () => {
  const { homedir } = await import('node:os'); const { realpath } = await import('node:fs/promises');
  assert.equal(await canonicalRoot('~'), await realpath(homedir()));
  assert.equal(await canonicalRoot('~/.'), await realpath(homedir()));
  await assert.rejects(canonicalRoot('./relative'));
  await fixture(async (root, put) => { await put('a.txt', 'file'); await assert.rejects(canonicalRoot(join(root, 'a.txt'))); });
});

test('パス直接入力のAPIでもホーム省略形を解決して探索と除外を保存する', async () => {
  await fixture(async (root, put) => {
    await put('package.json', '{"name":"home-relative-api"}'); await put('ignored/a.txt', '');
    const { relative } = await import('node:path'); const { homedir } = await import('node:os');
    const abbreviated = `~/${relative(homedir(), root)}`;
    const store = new Store(':memory:'); const { api, call } = client(store);
    try {
      await call('/session'); let scan: Scan = (await call('/scans', { root: abbreviated })).data.scan;
      assert.equal(scan.root, root);
      for (let i = 0; i < 200 && scan.status === 'running'; i++) { await new Promise(r => setTimeout(r, 5)); scan = (await call(`/scans/${scan.id}`)).data.scan; }
      assert.equal(scan.status, 'completed');
      const excluded = await call('/exclusions', { path: `${abbreviated}/ignored` });
      assert.equal(excluded.response.status, 200); assert.deepEqual(excluded.data.exclusions, [join(root, 'ignored')]);
    } finally { await api.shutdownScans(); store.close(); }
  });
});
