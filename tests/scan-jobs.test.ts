import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, opendir } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot, newScan, runScan } from '../server/scanner.js';
import { ScanJobs, type ScanJobsOptions } from '../server/scan-jobs.js';
import { Store } from '../server/store.js';
import type { Candidate, Scan } from '../shared/types.js';

type Put = (file: string, data?: string) => Promise<void>;
async function fixture(fn: (root: string, put: Put, base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-jobs-'));
  const tree = join(base, 'tree'); await mkdir(tree);
  const put: Put = async (file, data = '') => { await mkdir(dirname(join(tree, file)), { recursive: true }); await writeFile(join(tree, file), data); };
  try { await fn(await canonicalRoot(tree), put, base); } finally { await rm(base, { recursive: true, force: true }); }
}
const open = (file: string, options?: ScanJobsOptions) => { const store = new Store(file); return { store, jobs: new ScanJobs(store.db, options) }; };
async function scan(jobs: ScanJobs, root: string, exclusions: string[] = []) {
  const created = jobs.create(root, exclusions); await jobs.run(created.id); return jobs.get(created.id)!;
}
async function legacy(root: string, exclusions: string[] = []) {
  const s = newScan(root); await runScan(s, undefined, undefined, { exclusions, depth: 10_000 }); return s;
}
const shape = (candidates: Candidate[]) => candidates.map(({ registered: _, registeredInside: __, ...rest }) => rest).sort((a, b) => a.path.localeCompare(b.path));
const counts = (s: Scan) => ({ visited: s.visited, excluded: s.excluded, found: s.found });
const tables = (store: Store, id: string) => Object.fromEntries(['scan_job_queue', 'scan_job_staging', 'scan_job_nodes', 'scan_job_issues', 'scan_job_candidates', 'scan_job_parts']
  .map(t => [t, (store.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE scan_id=?`).get(id) as { n: number }).n]));

// Every grouping rule of the in-memory scan in one tree: workspaces, boundaries, nested and container Git, WordPress, pip targets.
async function mixed(put: Put) {
  await put('web/package.json', JSON.stringify({ name: 'workspace', workspaces: ['apps/*'] }));
  await put('web/apps/front/package.json', JSON.stringify({ name: 'front', dependencies: { next: '15' } }));
  await put('web/apps/api/package.json', JSON.stringify({ name: 'api' }));
  await put('web/apps/independent/package.json', '{"name":"independent"}');
  await put('web/apps/independent/.git', 'gitdir: x');
  await put('sam/template.yaml', 'Transform: AWS::Serverless-2016-10-31\nResources:\n  Fn:\n    Type: AWS::Serverless::Function');
  await put('sam/f01/requirements.txt', 'requests');
  await put('sam/layer/requirements.txt', 'numpy');
  await put('sam/layer/numpy-1.21.6.dist-info/METADATA');
  await put('sam/layer/numpy/core/setup.py', 'raise Exception("bundled")');
  await put('flutter/pubspec.yaml', 'name: clima\ndependencies:\n  flutter:\n    sdk: flutter');
  await put('flutter/android/app/build.gradle');
  await put('repo/.git', 'gitdir: somewhere');
  await put('repo/tools/package.json', '{"name":"tools"}');
  await put('repo/vendor-lib/.git', 'gitdir: elsewhere');
  await put('repo/vendor-lib/sub/package.json', '{"name":"sub"}');
  await put('empty-repo/.git', 'gitdir: empty');
  await put('site/wp-load.php', '<?php');
  await put('site/wp-includes/sodium_compat/composer.json', '{"name":"core/lib"}');
  await put('site/wp-admin/x/package.json', '{"name":"admin"}');
  await put('site/wp-content/plugins/index.php', '<?php // Silence is golden.');
  await put('site/wp-content/plugins/big/composer.json', '{"name":"vendor/big"}');
  await put('site/wp-content/plugins/big/deep/package.json', '{"name":"inner"}');
  await put('site/wp-content/themes/mine/style.css', '/*\nTheme Name: Mine\n*/');
  await put('site/wp-content/themes/mytheme/.git/HEAD', 'ref: refs/heads/main');
  await put('site/wp-content/themes/mytheme/package.json', '{"name":"mytheme"}');
  await put('site/wp-content/themes/mytheme/assets/package.json', '{"name":"assets"}');
  await put('site/wp-content/uploads/2024/package.json', '{"name":"upload"}');
  await put('backup/themes/t/style.css', '/* Theme Name: T */');
  await put('backup/plugins/p/composer.json', '{"name":"p/p"}');
  await put('broken/package.json', '{broken');
  await put('app/node_modules/dep/package.json', '{"name":"dep"}');
  await put('archive/old/package.json', '{"name":"old"}');
}

test('DB探索はメモリ上の探索と同じ候補・構成・fingerprint・件数を出す', async () => {
  await fixture(async (root, put, base) => {
    await mixed(put);
    await symlink(join(root, 'web'), join(root, 'linked'));
    await symlink('/etc', join(root, 'outside'));
    const exclusions = [join(root, 'archive')];
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 3 });
    try {
      const result = await scan(jobs, root, exclusions);
      const expected = await legacy(root, exclusions);
      assert.equal(result.status, expected.status); assert.equal(result.status, 'partial');
      assert.deepEqual(shape(result.candidates), shape(expected.candidates));
      assert.deepEqual(counts(result), counts(expected));
      assert.equal(result.issueCount, expected.issues.length);
      assert.ok(['workspace', 'independent', 'sam', 'clima', 'tools', 'sub', 'site', 'mytheme'].every(name => result.candidates.some(c => c.name === name)));
      assert.ok(!result.candidates.some(c => ['dep', 'old', 'admin', 'upload', 'inner', 'core/lib'].includes(c.name)));
      // A scan rooted at a theme skips its internals as the site scan does.
      const theme = join(root, 'site/wp-content/themes/mytheme');
      assert.deepEqual(shape((await scan(jobs, theme)).candidates), shape((await legacy(theme)).candidates));
    } finally { store.close(); }
  });
});

test('深さ・件数の上限なく読み、1つのフォルダに大量のファイルがあっても分けて保存する', async () => {
  await fixture(async (root, put, base) => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
    await put(`${deep}/package.json`, '{"name":"deep"}');
    for (let i = 0; i < 1200; i++) await put(`big/file-${i}.txt`, '');
    for (let i = 0; i < 300; i++) await mkdir(join(root, `big/empty-${i}`));
    for (let i = 0; i < 60; i++) await put(`big/dir-${i}/package.json`, `{"name":"p${i}"}`);
    let checkpoints = 0;
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 40, onCheckpoint: () => checkpoints++ });
    try {
      const result = await scan(jobs, root);
      assert.equal(result.status, 'completed');
      assert.ok(result.candidates.some(c => c.name === 'deep'));
      assert.equal(result.candidates.filter(c => /^p\d+$/.test(c.name)).length, 60);
      assert.deepEqual(counts(result), counts(await legacy(root)));
      assert.ok(checkpoints >= 360 / 40, 'the subfolders of the big folder are committed in several batches');
      assert.equal(tables(store, result.id).scan_job_staging, 0, 'nothing staged after completion');
      assert.equal(result.processedFolders, 1 + 20 + 1 + 300 + 60);
    } finally { store.close(); }
  });
});

// Pausing after every third commit must still finish: each commit keeps its progress, inside a large folder, in grouping,
// and inside a project with many folders.
test('小さなバッチで何度も一時停止し、開き直して再開しても重複なく同じ結果になる', { timeout: 120_000 }, async () => {
  await fixture(async (root, put, base) => {
    await mixed(put);
    for (let i = 0; i < 300; i++) await put(`many/f${i}.txt`, '');
    for (let i = 0; i < 12; i++) await put(`many/sub${i}/package.json`, `{"name":"m${i}"}`);
    for (let i = 0; i < 60; i++) await mkdir(join(root, `wide/d${String(i).padStart(2, '0')}`), { recursive: true });
    await put('mono/Dockerfile', 'FROM node:24');
    for (let i = 0; i < 40; i++) await put(`mono/pkg${i}/package.json`, `{"name":"mono-${i}"}`);
    for (let i = 0; i < 5; i++) await put(`mono/pkg${i}/inner/package.json`, `{"name":"mono-inner-${i}"}`);
    const reference = open(join(base, 'reference.sqlite'));
    const expected = await scan(reference.jobs, root);
    reference.store.close();
    const file = join(base, 'db.sqlite');
    let { store, jobs } = open(file);
    const id = jobs.create(root, []).id;
    store.close();
    let rounds = 0;
    for (;;) {
      const controller = new AbortController(); let seen = 0;
      ({ store, jobs } = open(file, { batchSize: 7, onCheckpoint: () => { if (++seen === 3) controller.abort('pause'); } }));
      // The first reopen finds the job created but never run, and pauses it rather than starting it.
      assert.equal(jobs.get(id)!.status, 'paused'); jobs.resume(id);
      await jobs.run(id, controller.signal);
      const status = jobs.get(id)!.status;
      rounds++;
      if (status !== 'paused') break;
      store.close();
      // A pause that loses its progress would loop here forever.
      assert.ok(rounds < 1000, `still paused after ${rounds} rounds: a pause does not keep its progress`);
    }
    try {
      assert.ok(rounds > 5, `paused ${rounds} times`);
      const result = jobs.get(id)!;
      assert.equal(result.phase, 'done'); assert.equal(result.canResume, false);
      const mono = result.candidates.find(c => c.path === join(root, 'mono'))!;
      assert.equal(mono.components.length, 45);
      assert.equal(jobs.candidate(id, mono.id)!.fingerprint, expected.candidates.find(c => c.path === mono.path)!.fingerprint);
      assert.equal(result.status, expected.status);
      assert.deepEqual(shape(result.candidates), shape(expected.candidates));
      assert.deepEqual(counts(result), counts(expected));
      assert.equal(result.issueCount, expected.issueCount);
      const dupes = store.db.prepare('SELECT COUNT(*) - COUNT(DISTINCT path) AS n FROM scan_job_queue WHERE scan_id=?').get(id) as { n: number };
      assert.equal(dupes.n, 0);
      assert.equal(tables(store, id).scan_job_nodes, result.found);
    } finally { store.close(); }
  });
});

test('途中でDBが使えなくなっても完了にせず、再起動後は一時停止として残り、再開で完了する', async () => {
  await fixture(async (root, put, base) => {
    await mixed(put);
    const reference = open(join(base, 'reference.sqlite'));
    const expected = await scan(reference.jobs, root);
    reference.store.close();
    const file = join(base, 'db.sqlite');
    let seen = 0;
    let { store, jobs } = open(file, { batchSize: 4, onCheckpoint: () => { if (++seen === 4) store.close(); } });
    const id = jobs.create(root, []).id;
    await jobs.run(id); // resolves although every later write fails
    ({ store, jobs } = open(file, { batchSize: 4 }));
    try {
      const recovered = jobs.get(id)!;
      assert.equal(recovered.status, 'paused');
      assert.ok(recovered.pending! > 0 && recovered.processedFolders! > 0);
      // The legacy recovery in Store leaves a persistent scan alone.
      assert.equal(JSON.parse((store.db.prepare('SELECT payload FROM scans WHERE id=?').get(id) as { payload: string }).payload).status, 'paused');
      await assert.rejects(jobs.run(id), /再開/);
      jobs.resume(id); await jobs.run(id);
      const result = jobs.get(id)!;
      assert.deepEqual(shape(result.candidates), shape(expected.candidates));
      assert.deepEqual(counts(result), counts(expected));
    } finally { store.close(); }
  });
});

test('保存先の容量不足(SQLITE_FULL)では失敗として止まり、保存済みの所から再開できる', async () => {
  await fixture(async (root, put, base) => {
    for (let i = 0; i < 400; i++) await put(`p${i}/package.json`, JSON.stringify({ name: `project-${i}`, description: 'x'.repeat(200) }));
    const file = join(base, 'db.sqlite');
    let { store, jobs } = open(file, { batchSize: 20 });
    const id = jobs.create(root, []).id;
    const pages = (store.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    store.db.exec(`PRAGMA max_page_count = ${pages + 8}`);
    await jobs.run(id);
    const stopped = jobs.get(id)!;
    assert.equal(stopped.status, 'failed');
    store.close();
    ({ store, jobs } = open(file, { batchSize: 20 }));
    try {
      const saved = jobs.get(id)!;
      assert.equal(saved.status, 'failed');
      assert.ok(saved.pending! > 0 && saved.found! < 400);
      jobs.resume(id); await jobs.run(id);
      const result = jobs.get(id)!;
      assert.equal(result.status, 'completed'); assert.equal(result.candidateCount, 400); assert.equal(result.found, 400);
    } finally { store.close(); }
  });
});

test('読めないフォルダは未確認として候補に示し、読み直しで問題を消す', async () => {
  await fixture(async (root, put, base) => {
    await put('site/Dockerfile', 'FROM node:24');
    await put('site/a/package.json', '{"name":"a"}');
    await put('site/b/package.json', '{"name":"b"}');
    // Read again, b/lib is queued after c/x. Components and the fingerprint still follow the order of a fresh scan.
    await put('site/b/lib/package.json', '{"name":"lib"}');
    await put('site/c/x/package.json', '{"name":"x"}');
    await put('other/package.json', '{"name":"other"}');
    let broken = true;
    const flaky = ((path: string, ...rest: unknown[]) => {
      if (broken && path === join(root, 'site/b')) return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      return (opendir as (...a: unknown[]) => ReturnType<typeof opendir>)(path, ...rest);
    }) as typeof opendir;
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 2, opendir: flaky });
    try {
      const first = await scan(jobs, root);
      assert.equal(first.status, 'partial'); assert.equal(first.errorCount, 1);
      assert.ok(first.issues.some(i => i.path === join(root, 'site/b')));
      const site = first.candidates.find(c => c.name === 'site')!;
      assert.equal(site.incomplete, true); assert.deepEqual(site.components.map(c => c.name), ['a', 'x']);
      assert.equal(first.canRetry, true);
      assert.equal(first.candidates.find(c => c.name === 'other')!.incomplete, undefined);
      assert.throws(() => jobs.resume(first.id), /再開/);
      broken = false;
      jobs.retry(first.id); await jobs.run(first.id);
      const second = jobs.get(first.id)!;
      assert.equal(second.status, 'completed'); assert.equal(second.errorCount, 0); assert.equal(second.issueCount, 0);
      const fixed = second.candidates.find(c => c.name === 'site')!;
      assert.equal(fixed.incomplete, undefined); assert.deepEqual(fixed.components.map(c => c.name), ['a', 'b', 'lib', 'x']);
      const fresh = await scan(jobs, root);
      assert.deepEqual(shape(second.candidates), shape(fresh.candidates));
      assert.deepEqual(shape(second.candidates), shape((await legacy(root)).candidates));
      assert.deepEqual(counts(second), counts(await legacy(root)));
      assert.equal(second.processedFolders, fresh.processedFolders);
      assert.equal(tables(store, first.id).scan_job_nodes, second.found);
      assert.throws(() => jobs.retry(first.id), /読み直す/);
    } finally { store.close(); }
  });
});

test('読めなかった設定ファイルのフォルダも一時停止中から読み直し、件数を二重に数えず新しい探索と同じ結果にする', { timeout: 60_000 }, async () => {
  await fixture(async (root, put, base) => {
    await mixed(put);
    const broken = join(root, 'broken/package.json');
    let watch = true; const controller = new AbortController();
    // Pauses once the parse failure is saved.
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 3, onCheckpoint: () => {
      if (watch && store.db.prepare('SELECT 1 FROM scan_job_issues WHERE path=?').get(broken)) { watch = false; controller.abort('pause'); }
    } });
    try {
      const created = jobs.create(root, []);
      await jobs.run(created.id, controller.signal);
      const paused = jobs.get(created.id)!;
      assert.equal(paused.status, 'paused'); assert.equal(paused.canResume, true); assert.equal(paused.canRetry, true);
      assert.ok(paused.issues.some(i => i.path === broken));
      await put('broken/package.json', '{"name":"fixed"}');
      jobs.retry(created.id); await jobs.run(created.id);
      const second = jobs.get(created.id)!;
      const reference = open(join(base, 'fresh.sqlite'));
      const fresh = await scan(reference.jobs, root);
      reference.store.close();
      assert.equal(second.status, fresh.status);
      assert.equal(second.issueCount, fresh.issueCount);
      assert.ok(!second.issues.some(i => i.path === broken));
      assert.ok(second.candidates.some(c => c.name === 'fixed'));
      assert.deepEqual(shape(second.candidates), shape(fresh.candidates));
      assert.deepEqual(counts(second), counts(fresh));
      assert.equal(second.processedFolders, fresh.processedFolders);
      assert.equal(second.errorCount, 0);
      assert.equal(tables(store, created.id).scan_job_nodes, second.found);
      assert.equal(tables(store, created.id).scan_job_staging, 0);
    } finally { store.close(); }
  });
});

test('壊れたmanifest・消えた探索先・読む前にsymlinkへ差し替わったフォルダを辿らない', async () => {
  await fixture(async (root, put, base) => {
    await put('broken/package.json', '{broken');
    await put('a/inner/package.json', '{"name":"inner"}');
    await mkdir(join(base, 'elsewhere/secret'), { recursive: true });
    await writeFile(join(base, 'elsewhere/secret/package.json'), '{"name":"secret"}');
    let swapped = false;
    const db: { store?: Store } = {};
    // Once a/ is queued, and before it is read, it becomes a link out of the root.
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 1, onCheckpoint: () => {
      if (swapped || !db.store!.db.prepare("SELECT 1 FROM scan_job_queue WHERE path=? AND state='pending'").get(join(root, 'a'))) return;
      swapped = true;
      renameSync(join(root, 'a'), join(base, 'a-moved'));
      symlinkSync(join(base, 'elsewhere'), join(root, 'a'));
    } });
    db.store = store;
    try {
      const created = jobs.create(root, []);
      await jobs.run(created.id);
      assert.ok(swapped);
      const result = jobs.get(created.id)!;
      assert.equal(result.status, 'partial');
      assert.ok(!result.candidates.some(c => c.name === 'secret' || c.name === 'inner'));
      assert.ok(result.issues.some(i => i.path === join(root, 'a')));
      assert.ok(result.candidates.find(c => c.name === 'broken')!.evidence.some(e => e.detail.includes('失敗')));
      const gone = join(base, 'gone'); await mkdir(gone);
      const missing = jobs.create(gone, []); await rm(gone, { recursive: true });
      await jobs.run(missing.id);
      const empty = jobs.get(missing.id)!;
      assert.equal(empty.status, 'partial'); assert.equal(empty.candidateCount, 0); assert.equal(empty.errorCount, 1);
    } finally { store.close(); }
  });
});

test('一覧はページ・検索・登録状態・後からの除外をSQLで数え、要約は軽いまま保存する', async () => {
  await fixture(async (root, put, base) => {
    for (let i = 0; i < 25; i++) await put(`apps/app-${String(i).padStart(2, '0')}/package.json`, JSON.stringify({ name: `app-${String(i).padStart(2, '0')}` }));
    await put('tools/cli/Cargo.toml', '[package]\nname="cli"');
    await put('giant/Dockerfile', 'FROM x');
    for (let i = 0; i < 250; i++) await put(`giant/c${i}/package.json`, `{"name":"c${i}"}`);
    const { store, jobs } = open(join(base, 'db.sqlite'));
    try {
      const result = await scan(jobs, root);
      assert.equal(result.candidateCount, 27); assert.equal(result.filteredCount, 27);
      const page = jobs.get(result.id, { limit: 10, offset: 5 })!;
      assert.equal(page.candidates.length, 10); assert.equal(page.filteredCount, 27);
      const counted = jobs.get(result.id, { limit: 0, filter: 'new' })!;
      assert.equal(counted.candidates.length, 0); assert.equal(counted.candidateCount, 27); assert.equal(counted.filteredCount, 27);
      const listed = jobs.get(result.id)!.candidates;
      const all = listed.map(c => c.id);
      assert.deepEqual(page.candidates.map(c => c.id), all.slice(5, 15));
      assert.deepEqual(jobs.get(result.id, { query: 'RUST' })!.candidates.map(c => c.name), ['cli']);
      // A very large project shows its first rows in a page and states the full count; candidate() returns everything.
      const giant = jobs.get(result.id, { query: 'giant' })!.candidates[0] as Candidate & { componentTotal?: number };
      assert.equal(giant.components.length, 200); assert.equal(giant.componentTotal, 250);
      assert.equal(jobs.candidate(result.id, giant.id)!.components.length, 250);
      const app = jobs.candidate(result.id, listed.find(c => c.name === 'app-03')!.id)!;
      store.import('batch', [app]);
      assert.equal(jobs.get(result.id, { filter: 'registered' })!.filteredCount, 1);
      assert.equal(jobs.get(result.id, { filter: 'new' })!.filteredCount, 26);
      assert.equal(jobs.candidate(result.id, app.id)!.registered, true);
      const excluded = jobs.get(result.id, { exclusions: [join(root, 'apps')] })!;
      assert.equal(excluded.candidateCount, 2);
      assert.deepEqual(jobs.selectIds(result.id, { filter: 'new', query: '/apps/app-', limit: 5 }),
        listed.filter(c => c.name.startsWith('app-') && c.id !== app.id).slice(0, 5).map(c => c.id));
      const saved = JSON.parse((store.db.prepare('SELECT payload FROM scans WHERE id=?').get(result.id) as { payload: string }).payload) as Scan;
      assert.equal(saved.candidates.length, 0); assert.equal(saved.candidateCount, 27); assert.equal(saved.persistent, true);
      assert.equal(jobs.list()[0].id, result.id); assert.equal(jobs.list()[0].candidates.length, 0);
      assert.equal(jobs.get('missing'), null); assert.equal(jobs.candidate(result.id, 'missing'), undefined);
      assert.deepEqual(jobs.selectIds('missing', {}), []);
      assert.throws(() => jobs.resume('missing'), /見つかりません/);
    } finally { store.close(); }
  });
});

test('以前の形式で保存された探索も同じ読み方で返す', async () => {
  await fixture(async (root, put, base) => {
    await put('one/package.json', '{"name":"one"}');
    await put('two/package.json', '{"name":"two"}');
    const { store, jobs } = open(join(base, 'db.sqlite'));
    try {
      const old = newScan(root); await runScan(old); store.saveScan(old);
      assert.equal(jobs.get(old.id, { query: 'two' })!.candidates.length, 1);
      assert.equal(jobs.get(old.id)!.candidateCount, 2);
      assert.equal(jobs.candidate(old.id, old.candidates[0].id)!.path, old.candidates[0].path);
      assert.equal(jobs.selectIds(old.id, { filter: 'new' }).length, 2);
      assert.equal(jobs.list()[0].candidates.length, 0);
      assert.equal(jobs.list()[0].candidateCount, 2);
      const counted = jobs.get(old.id, { limit: 0 })!;
      assert.equal(counted.candidates.length, 0); assert.equal(counted.candidateCount, 2);
      // An old scan can be deleted too. Projects registered from it stay.
      store.import('batch', [jobs.candidate(old.id, old.candidates[0].id)!]);
      jobs.remove(old.id);
      assert.equal(jobs.get(old.id), null);
      assert.equal(store.projects().length, 1);
      assert.throws(() => jobs.remove(old.id), /見つかりません/);
    } finally { store.close(); }
  });
});

test('実行は1つずつで、削除は停止中の探索の保存分だけを消し登録済みプロジェクトを残す', async () => {
  await fixture(async (root, put, base) => {
    await put('one/package.json', '{"name":"one"}');
    for (let i = 0; i < 50; i++) await put(`many/d${i}/x.txt`, '');
    const controller = new AbortController();
    const { store, jobs } = open(join(base, 'db.sqlite'), { batchSize: 5, onCheckpoint: () => controller.abort('pause') });
    try {
      const first = jobs.create(root, []);
      assert.throws(() => jobs.create(root, []), /現在の探索/);
      assert.throws(() => jobs.remove(first.id), /実行中/);
      const run = jobs.run(first.id, controller.signal);
      await assert.rejects(jobs.run(first.id), /現在の探索/);
      await run;
      assert.equal(jobs.get(first.id)!.status, 'paused');
      jobs.resume(first.id); await jobs.run(first.id, new AbortController().signal);
      const done = jobs.get(first.id)!;
      assert.equal(done.status, 'completed');
      assert.throws(() => jobs.resume(first.id), /再開/);
      store.import('batch', [jobs.candidate(first.id, done.candidates[0].id)!]);
      jobs.remove(first.id);
      assert.equal(jobs.get(first.id), null);
      assert.ok(Object.values(tables(store, first.id)).every(n => n === 0));
      assert.equal(store.projects().length, 1);
      // Cancelling keeps what was found, marks unread projects, and can be resumed.
      const cancel = new AbortController();
      let seen = 0;
      const other = new ScanJobs(store.db, { batchSize: 1, onCheckpoint: () => { if (++seen === 2) cancel.abort(); } });
      const second = other.create(root, []);
      await other.run(second.id, cancel.signal);
      const cancelled = other.get(second.id)!;
      assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.pending! > 0);
      other.resume(second.id); await other.run(second.id);
      assert.equal(other.get(second.id)!.status, 'completed');
    } finally { store.close(); }
  });
});
