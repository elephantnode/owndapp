import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { ScanJobs } from '../server/scan-jobs.js';

test('DB探索は100万項目を超える列挙でも打ち切らず、無関係な名前を保持しない', { timeout: 20000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-volume-')); const root = await realpath(base);
  await writeFile(join(root, 'package.json'), '{"name":"volume"}');
  await mkdir(join(root, 'after-limit')); await writeFile(join(root, 'after-limit/package.json'), '{"name":"after-limit"}');
  const store = new Store(':memory:');
  try {
    // A streaming directory adapter tests the entry count without writing a million files to the user's disk.
    const reader = (async function* () {
      const entry = (name: string, directory = false) => ({ name, isSymbolicLink: () => false, isDirectory: () => directory });
      yield entry('package.json');
      for (let i = 0; i < 1_000_020; i++) yield entry(`file-${i}.txt`);
      yield entry('after-limit', true);
    });
    const jobs = new ScanJobs(store.db, { opendir: (async (path: string, options: { bufferSize?: number }) => path === root ? reader() : opendir(path, options)) as unknown as typeof opendir, batchSize: 500 });
    const scan = jobs.create(root, []); await jobs.run(scan.id);
    const done = jobs.get(scan.id)!;
    assert.equal(done.status, 'completed'); assert.equal(done.visited, 1_000_023); assert.equal(done.candidateCount, 2);
    assert.ok(done.candidates.some(c => c.name === 'volume')); assert.ok(done.candidates.some(c => c.name === 'after-limit'));
    assert.equal(store.scan(scan.id)!.candidates.length, 0);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});

test('64階層先のプロジェクトも途中の深さで除外しない', { timeout: 20000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-depth-')); const root = await realpath(base);
  const folder = join(root, ...Array.from({ length: 64 }, () => 'd'));
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'package.json'), '{"name":"deep-64"}');
  const store = new Store(':memory:');
  try {
    const jobs = new ScanJobs(store.db); const scan = jobs.create(root, []); await jobs.run(scan.id);
    const done = jobs.get(scan.id)!;
    assert.equal(done.status, 'completed'); assert.equal(done.candidateCount, 1); assert.equal(done.candidates[0].path, folder);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});

test('再開時にディレクトリの列挙順が変わっても、保存済みの位置で子フォルダを飛ばさない', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-order-')); const root = await realpath(base);
  await writeFile(join(root, 'package.json'), '{"name":"root-check"}');
  for (const name of ['a', 'b', 'c']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'package.json'), JSON.stringify({ name })); }
  const store = new Store(':memory:'); const pause = new AbortController(); let asked = false; let opens = 0;
  try {
    const reader = (async (path: string, options: { bufferSize?: number }) => {
      if (path !== root) return opendir(path, options);
      const names = opens++ === 0 ? ['a', 'b', 'c', 'package.json'] : ['b', 'a', 'c', 'package.json'];
      return (async function* () { for (const name of names) yield { name, isSymbolicLink: () => false, isDirectory: () => name !== 'package.json' }; })();
    }) as unknown as typeof opendir;
    const jobs = new ScanJobs(store.db, { opendir: reader, batchSize: 1, onCheckpoint: () => { if (!asked) { asked = true; pause.abort('pause'); } } });
    const scan = jobs.create(root, []); await jobs.run(scan.id, pause.signal);
    assert.equal(jobs.get(scan.id)!.status, 'paused'); jobs.resume(scan.id); await jobs.run(scan.id);
    const done = jobs.get(scan.id)!;
    assert.equal(done.status, 'completed'); assert.deepEqual(done.candidates.map(c => c.name).sort(), ['a', 'b', 'c', 'root-check']);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});

test('フォルダ別件数のない開発途中の保存形式は再試行で二重計上しない', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-counter-migration-')); const root = await realpath(base); const folder = join(root, 'fixtures');
  await mkdir(folder); await writeFile(join(folder, 'package.json'), '{bad json');
  const file = join(root, 'catalog.sqlite'); let store = new Store(file);
  try {
    const jobs = new ScanJobs(store.db); const scan = jobs.create(folder, []); await jobs.run(scan.id);
    assert.equal(jobs.get(scan.id)!.status, 'partial');
    store.db.exec('ALTER TABLE scan_job_queue DROP COLUMN entries; ALTER TABLE scan_job_queue DROP COLUMN skipped; ALTER TABLE scan_jobs DROP COLUMN counter_format;');
    store.close(); store = new Store(file);
    const recovered = new ScanJobs(store.db); const saved = recovered.get(scan.id)!;
    assert.equal(saved.candidateCount, 1); assert.equal(saved.canRetry, false);
    assert.throws(() => recovered.retry(scan.id), /二重/);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});

test('候補の整理中のキャンセルも保存して止まり、続きから完了できる', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owndapp-group-cancel-')); const root = await realpath(base);
  for (let i = 0; i < 8; i++) { await mkdir(join(root, `a${i}`)); await writeFile(join(root, `a${i}/package.json`), JSON.stringify({ name: `a${i}` })); }
  const store = new Store(':memory:'); const stop = new AbortController(); let id = ''; let asked = false;
  try {
    const jobs = new ScanJobs(store.db, { batchSize: 1, onCheckpoint: () => {
      if (!asked && jobs.get(id, { limit: 0 })?.phase === 'group') { asked = true; stop.abort(); }
    } });
    id = jobs.create(root, []).id; await jobs.run(id, stop.signal);
    assert.ok(asked); assert.equal(jobs.get(id)!.status, 'cancelled');
    assert.equal(jobs.get(id)!.canResume, true); jobs.resume(id); await jobs.run(id);
    const done = jobs.get(id)!; assert.equal(done.status, 'completed'); assert.equal(done.candidateCount, 8);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});
