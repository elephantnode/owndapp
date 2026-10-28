import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { compareSemver, dedupe, fixedVersion, fixtureClient, OsvError, queryAll, toAdvisory, type OsvClient, type OsvRecord } from '../server/osv.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import type { Project } from '../shared/types.js';

const ghsa = (id: string, name: string, events: Record<string, string>[], extra: Partial<OsvRecord> = {}): OsvRecord => ({
  id, summary: `${name} の問題`, aliases: [], modified: '2026-01-01T00:00:00Z', published: '2025-12-01T00:00:00Z',
  affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events }] }], database_specific: { severity: 'HIGH' },
  references: [{ type: 'ADVISORY', url: `https://github.com/advisories/${id}` }], ...extra,
});

test('semverの順序と、該当範囲の修正版の選び方', () => {
  assert.ok(compareSemver('1.2.10', '1.2.9') > 0);
  assert.ok(compareSemver('2.0.0-beta.2', '2.0.0') < 0);
  assert.ok(compareSemver('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  const record = ghsa('GHSA-a', 'lodash', [{ introduced: '0' }, { fixed: '4.17.21' }]);
  assert.equal(fixedVersion(record, 'lodash', '4.17.15'), '4.17.21');
  assert.equal(fixedVersion(record, 'lodash', '4.17.21'), null);
  // Two maintained lines: the fix of the line containing the version is chosen.
  const lines = ghsa('GHSA-b', 'next', [{ introduced: '13.0.0' }, { fixed: '13.5.8' }, { introduced: '14.0.0' }, { fixed: '14.2.21' }]);
  assert.equal(fixedVersion(lines, 'next', '14.1.0'), '14.2.21');
  assert.equal(fixedVersion(lines, 'next', '13.4.0'), '13.5.8');
  assert.equal(fixedVersion(ghsa('GHSA-c', 'x', [{ introduced: '0' }, { last_affected: '1.0.0' }]), 'x', '0.9.0'), null, 'last_affected names no fix');
  assert.equal(fixedVersion(lines, 'other', '14.1.0'), null);
});

test('重大度・悪意あるパッケージ・別名の重複を扱う', () => {
  assert.equal(toAdvisory('GHSA-a', ghsa('GHSA-a', 'x', []), 'x', '1.0.0').severity, 'high');
  assert.equal(toAdvisory('GHSA-m', ghsa('GHSA-m', 'x', [], { database_specific: { severity: 'MODERATE' } }), 'x', '1.0.0').severity, 'moderate');
  assert.equal(toAdvisory('MAL-2025-1', undefined, 'x', '1.0.0').severity, 'malicious');
  const missing = toAdvisory('GHSA-z', undefined, 'x', '1.0.0');
  assert.equal(missing.detailsAvailable, false); assert.equal(missing.severity, 'unknown'); assert.equal(missing.fixed, null);
  const records = new Map<string, OsvRecord>([['GHSA-a', ghsa('GHSA-a', 'x', [], { aliases: ['CVE-2025-1'] })], ['CVE-2025-1', { id: 'CVE-2025-1' }]]);
  assert.deepEqual(dedupe(['GHSA-a', 'CVE-2025-1', 'GHSA-b', 'GHSA-a'], records), ['GHSA-a', 'GHSA-b']);
});

test('ページ送りを最後まで追い、失敗したバッチは空ではなく失敗として扱う', async () => {
  const pages: Record<string, string[][]> = { 'a@1.0.0': [['V1', 'V2'], ['V3']], 'b@1.0.0': [[]] };
  const sent: unknown[] = [];
  const client: OsvClient = {
    async queryBatch(queries) {
      sent.push(queries.map(q => `${q.name}@${q.version}:${q.pageToken || ''}`));
      return queries.map(q => { const list = pages[`${q.name}@${q.version}`]; const page = q.pageToken ? Number(q.pageToken) : 0;
        return { ids: list[page], nextPageToken: page + 1 < list.length ? String(page + 1) : undefined }; });
    },
    async vulnerability() { throw new Error('unused'); },
  };
  const outcome = await queryAll(client, [{ ecosystem: 'npm', name: 'a', version: '1.0.0' }, { ecosystem: 'npm', name: 'b', version: '1.0.0' }]);
  assert.deepEqual(outcome.ids.get('a@1.0.0'), ['V1', 'V2', 'V3']);
  assert.deepEqual(outcome.ids.get('b@1.0.0'), []);
  assert.deepEqual(sent, [['a@1.0.0:', 'b@1.0.0:'], ['a@1.0.0:1']]);
  const broken: OsvClient = { async queryBatch() { throw new Error('offline'); }, async vulnerability() { throw new Error('offline'); } };
  const failed = await queryAll(broken, [{ ecosystem: 'npm', name: 'a', version: '1.0.0' }]);
  assert.equal(failed.ids.has('a@1.0.0'), false); assert.ok(failed.failed.has('a@1.0.0'));
});

type Call = (path: string, body?: unknown) => Promise<{ response: Response; data: any }>;
// Starts a background check and waits for it to finish.
async function runCheck(call: Call, ids: string[]) {
  const started = await call('/vulnerabilities/check', { ids });
  assert.equal(started.response.status, 202);
  let job = started.data.job;
  for (let i = 0; i < 500 && job.status === 'running'; i++) { await new Promise(r => setTimeout(r, 2)); job = (await call('/vulnerabilities/job')).data.job; }
  return job;
}

async function setup(fn: (ctx: { root: string; store: Store; call: Call; ids: string[];
  sent: string[][]; setClient: (client: OsvClient) => void; waits: number[] }) => Promise<void>) {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-osv-')));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  await put('app/package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0', 'private-lib': '1.0.0' } }));
  await put('app/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { lodash: '^4.17.0', 'private-lib': '1.0.0' } },
    'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' },
    'node_modules/private-lib': { version: '1.0.0', resolved: 'git+ssh://git@example.com/me/private-lib.git#abc' },
    'node_modules/minimist': { version: '1.2.0', resolved: 'https://npm.example.com/minimist/-/minimist-1.2.0.tgz' },
    'node_modules/linked': { version: 'file:../linked' },
    'node_modules/semver': { version: '7.5.1', dev: true },
  } }));
  await put('clean/package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } }));
  await put('clean/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '^4.17.0' } },
    'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }));
  const store = new Store(':memory:');
  const sent: string[][] = [];
  let client: OsvClient = fixtureClient({});
  const recording: OsvClient = {
    async queryBatch(queries) { sent.push(queries.map(q => `${q.name}@${q.version}`)); return client.queryBatch(queries); },
    async vulnerability(id) { return client.vulnerability(id); },
  };
  const waits: number[] = [];
  const api = createApi(store, 4310, undefined, undefined, { osv: recording, osvOptions: { wait: async ms => { waits.push(ms); } } });
  let token = '';
  const call = async (path: string, body?: unknown) => {
    const response = await api.request(`http://127.0.0.1:4310/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any; if (path === '/session') token = data.token; return { response, data };
  };
  try {
    await call('/session');
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const { projectIds } = store.import('osv', ['app', 'clean', 'unread'].map(name => ({ ...base, id: name, name, path: join(root, name) })));
    await call('/dependencies/read', { ids: projectIds.slice(0, 2) });
    await fn({ root, store, call, ids: projectIds, sent, waits, setClient: next => { client = next; } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('照会前の確認では何も送らず、送る件数と送らない依存の理由を示す', async () => {
  await setup(async ({ call, ids, sent }) => {
    const { data } = await call('/vulnerabilities/preview', { ids });
    assert.deepEqual(data, { destination: 'https://api.osv.dev', projects: 2, notRead: ['unread'], packageVersions: 4, byEcosystem: { npm: 4 }, notSent: { git: 1, file: 1 }, nothingToSend: [], reread: [] });
    assert.equal(sent.length, 0);
  });
});

test('選んだプロジェクトの公開・別レジストリの依存だけを照会し、結果を台帳の時点に結びつける', async () => {
  await setup(async ({ root, store, call, ids, sent, setClient }) => {
    const [app, clean, unread] = ids;
    setClient(fixtureClient({
      'lodash@4.17.15': [ghsa('GHSA-p6mc-m468-83gw', 'lodash', [{ introduced: '0' }, { fixed: '4.17.19' }], { aliases: ['CVE-2020-8203'] }),
        ghsa('GHSA-old', 'lodash', [{ introduced: '0' }, { fixed: '4.17.12' }], { withdrawn: '2025-01-01T00:00:00Z' })],
      'minimist@1.2.0': [ghsa('GHSA-mini', 'minimist', [{ introduced: '0' }, { fixed: '1.2.6' }], { database_specific: { severity: 'CRITICAL' } })],
    }));
    const lockBefore = await readFile(join(root, 'app/package-lock.json'), 'utf8');
    const job = await runCheck(call, ids);
    assert.equal(job.status, 'done');
    // The unread project has no folder here, so it stays unread; read projects are checked.
    assert.deepEqual(job.result.results.map((r: any) => [r.name, r.status, r.count]), [['unread', 'not-read', 0], ['app', 'complete', 2], ['clean', 'complete', 0]]);
    // Only ecosystem, name and version are sent, once per package version. Git and local dependencies stay here.
    assert.deepEqual(sent.flat().sort(), ['lodash@4.17.15', 'lodash@4.17.21', 'minimist@1.2.0', 'semver@7.5.1'], 'a version without a resolved URL is sent as a registry package');
    assert.equal(await readFile(join(root, 'app/package-lock.json'), 'utf8'), lockBefore);
    const detail = (await call(`/projects/${app}/vulnerabilities`)).data;
    assert.deepEqual(detail.summary, { checkedAt: detail.check.checkedAt, status: 'complete', count: 2, highest: 'critical', stale: false });
    const lodash = detail.check.findings.find((f: any) => f.dependency.name === 'lodash');
    assert.deepEqual(lodash.advisories.map((a: any) => [a.id, a.fixed, a.severity]), [['GHSA-p6mc-m468-83gw', '4.17.19', 'high']], 'withdrawn advisories are left out');
    assert.equal(lodash.dependency.direct, true);
    assert.deepEqual(detail.check.notSent, { git: 1, file: 1 });
    const projects: Project[] = (await call('/projects')).data.projects;
    assert.equal(projects.find(p => p.id === clean)!.vulnerabilities!.count, 0);
    assert.equal(projects.find(p => p.id === unread)!.vulnerabilities, undefined);
    assert.match(JSON.stringify(store.getHistory(app)), /vulnerabilities_checked/);
    // Reading identical content again preserves the result without contacting OSV.
    const requestsBeforeRead = sent.length;
    await call('/dependencies/read', { ids: [app] });
    assert.equal((await call(`/projects/${app}/vulnerabilities`)).data.summary.stale, false);
    assert.equal((await call('/projects')).data.projects.find((p: Project) => p.id === app).vulnerabilities.stale, false);
    assert.equal((await call('/queue')).data.projects[app].stale, false);
    assert.equal(sent.length, requestsBeforeRead);
    // A real file-content change invalidates all three surfaces consistently.
    await writeFile(join(root, 'app/package-lock.json'), lockBefore + '\n');
    await call('/dependencies/read', { ids: [app] });
    assert.equal((await call(`/projects/${app}/vulnerabilities`)).data.summary.stale, true);
    assert.equal((await call('/projects')).data.projects.find((p: Project) => p.id === app).vulnerabilities.stale, true);
    assert.equal((await call('/queue')).data.projects[app].stale, true);
    assert.equal(sent.length, requestsBeforeRead);
  });
});

test('照会に失敗しても前回の結果を消さず、「0件」にもしない', async () => {
  await setup(async ({ store, call, ids, setClient }) => {
    const [app] = ids;
    setClient(fixtureClient({ 'lodash@4.17.15': [ghsa('GHSA-x', 'lodash', [{ introduced: '0' }, { fixed: '4.17.19' }])] }));
    await runCheck(call, [app]);
    const before = store.vulnerabilityCheck(app);
    setClient({ async queryBatch() { throw new Error('offline'); }, async vulnerability() { throw new Error('offline'); } });
    const offline = await runCheck(call, [app]);
    assert.equal(offline.status, 'failed'); assert.match(offline.error, /接続できませんでした/);
    const retained = store.vulnerabilityCheck(app)!;
    assert.equal(retained.status, 'partial');
    assert.equal(retained.checkedAt, before!.checkedAt);
    assert.ok(retained.attemptedAt);
    assert.ok(retained.findings.every(f => f.retained));
    assert.deepEqual(retained.findings.map(f => f.advisories), before!.findings.map(f => f.advisories));
    // Details that cannot be fetched still report the advisory id.
    setClient({ async queryBatch(queries) { return queries.map(q => ({ ids: q.name === 'lodash' ? ['GHSA-x'] : [] })); }, async vulnerability() { throw new Error('offline'); } });
    await runCheck(call, [app]);
    const advisory = store.vulnerabilityCheck(app)!.findings[0].advisories[0];
    assert.equal(advisory.id, 'GHSA-x'); assert.equal(advisory.detailsAvailable, false);
    assert.equal((await call('/vulnerabilities/check', { ids: [] })).response.status, 400);
    // A removed project keeps the advisories it had in the removal record.
    store.remove([app], 'test');
    assert.deepEqual(JSON.parse(store.removals()[0].payload).vulnerabilities.ids, ['GHSA-x']);
  });
});

test('照会できるものがないとき、プロジェクトごとの理由を返す', async () => {
  await setup(async ({ root, store, call }) => {
    await mkdir(join(root, 'nolock')); await writeFile(join(root, 'nolock/package.json'), '{}');
    await mkdir(join(root, 'gitonly'));
    await writeFile(join(root, 'gitonly/package.json'), JSON.stringify({ dependencies: { mine: 'github:me/mine' } }));
    await writeFile(join(root, 'gitonly/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { mine: 'github:me/mine' } },
      'node_modules/mine': { version: '1.0.0', resolved: 'git+ssh://git@github.com/me/mine.git#abc' } } }));
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const { projectIds } = store.import('empty', ['nolock', 'gitonly'].map(name => ({ ...base, id: name, name, path: join(root, name) })));
    await call('/dependencies/read', { ids: projectIds });
    const { data } = await call('/vulnerabilities/preview', { ids: projectIds });
    assert.equal(data.packageVersions, 0);
    // The project without a lockfile is read again first; the Git-only one has nothing to send.
    assert.deepEqual(data.reread, ['nolock']);
    assert.deepEqual(data.nothingToSend, [{ name: 'gitonly', reason: 'no-sendable' }]);
    const job = await runCheck(call, projectIds);
    assert.deepEqual(job.result.results.map((r: any) => [r.name, r.status]), [['nolock', 'nothing-to-check'], ['gitonly', 'nothing-to-check']]);
    // Nothing was judged, so no "no known vulnerabilities" result is stored for them.
    assert.equal(store.vulnerabilityCheck(projectIds[0]), null);
    assert.equal(store.vulnerabilityCheck(projectIds[1]), null);
  });
});

test('混雑やサーバーエラーは待って再試行し、Retry-After に従う', async () => {
  await setup(async ({ call, ids, setClient, waits, store }) => {
    const [app] = ids;
    let attempts = 0;
    const base = fixtureClient({ 'lodash@4.17.15': [ghsa('GHSA-x', 'lodash', [{ introduced: '0' }, { fixed: '4.17.19' }])] });
    setClient({
      async queryBatch(queries) {
        attempts++;
        if (attempts === 1) throw new OsvError('busy', 429, 3000);
        if (attempts === 2) throw new OsvError('down', 503);
        return base.queryBatch(queries);
      },
      async vulnerability(id) { return base.vulnerability(id); },
    });
    const job = await runCheck(call, [app]);
    assert.equal(job.status, 'done');
    assert.deepEqual(waits, [3000, 2000], 'Retry-After first, then a doubled wait');
    assert.equal(store.vulnerabilityCheck(app)!.findings[0].advisories[0].id, 'GHSA-x');
    // A plain 400 answer is not retried.
    waits.length = 0;
    setClient({ async queryBatch() { throw new OsvError('bad', 400); }, async vulnerability() { throw new Error('unused'); } });
    assert.equal((await runCheck(call, [app])).status, 'failed');
    assert.deepEqual(waits, []);
  });
});

test('未読み取りや読み取り後に変わったプロジェクトは、照会の前に読み取ってから判定する', async () => {
  await setup(async ({ root, store, call, ids, setClient }) => {
    const [app, , unread] = ids;
    setClient(fixtureClient({ 'lodash@4.17.21': [ghsa('GHSA-new', 'lodash', [{ introduced: '0' }, { fixed: '4.17.22' }])] }));
    // "unread" now gets a lockfile; "app" changes after it was read.
    await mkdir(join(root, 'unread'));
    await writeFile(join(root, 'unread/package.json'), JSON.stringify({ dependencies: { lodash: '4.17.21' } }));
    await writeFile(join(root, 'unread/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '4.17.21' } },
      'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }));
    await writeFile(join(root, 'app/package.json'), JSON.stringify({ dependencies: { lodash: '4.17.21' } }));
    await writeFile(join(root, 'app/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '4.17.21' } },
      'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }));
    const job = await runCheck(call, ids);
    assert.equal(job.status, 'done'); assert.equal(job.read, 3);
    assert.deepEqual(job.result.results.map((r: any) => [r.name, r.status, r.count]), [['app', 'complete', 1], ['clean', 'complete', 1], ['unread', 'complete', 1]]);
    assert.equal(store.vulnerabilityCheck(unread)!.findings[0].dependency.version, '4.17.21');
    assert.equal(store.vulnerabilityCheck(app)!.snapshotReadAt, store.dependencySnapshots().get(app)!.readAt);
    // Only one check runs at a time.
    setClient({ async queryBatch(q) { await new Promise(r => setTimeout(r, 30)); return q.map(() => ({ ids: [] })); }, async vulnerability() { throw new Error('unused'); } });
    assert.equal((await call('/vulnerabilities/check', { ids })).response.status, 202);
    assert.equal((await call('/vulnerabilities/check', { ids })).response.status, 409);
  });
});

test('前回lockがなかったプロジェクトは、照会の前に読み直して判定する', async () => {
  await setup(async ({ root, store, call, setClient }) => {
    await mkdir(join(root, 'later')); await writeFile(join(root, 'later/package.json'), JSON.stringify({ dependencies: { lodash: '4.17.15' } }));
    const base = { technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false };
    const { projectIds: [later] } = store.import('later', [{ ...base, id: 'later', name: 'later', path: join(root, 'later') }]);
    await call('/dependencies/read', { ids: [later] });
    assert.equal(store.dependencySnapshots().get(later)!.status, 'no-lock');
    // npm install later creates a lockfile. The check must notice it, not report "nothing to check".
    await writeFile(join(root, 'later/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '4.17.15' } },
      'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' } } }));
    const preview = (await call('/vulnerabilities/preview', { ids: [later] })).data;
    assert.deepEqual(preview.reread, ['later']); assert.equal(preview.packageVersions, 0);
    setClient(fixtureClient({ 'lodash@4.17.15': [ghsa('GHSA-x', 'lodash', [{ introduced: '0' }, { fixed: '4.17.19' }])] }));
    const job = await runCheck(call, [later]);
    assert.equal(job.read, 1);
    assert.deepEqual(job.result.results.map((r: any) => [r.status, r.count]), [['complete', 1]]);
  });
});


test('再照会はlock未変更でも毎回依存を読み直す', async () => {
  await setup(async ({ store, call, ids }) => {
    const [app] = ids;
    const before = store.getHistory(app).filter(h => h.action === 'dependencies_read').length;
    for (let i = 0; i < 2; i++) {
      const job = await runCheck(call, [app]);
      assert.equal(job.status, 'done'); assert.equal(job.read, 1);
      assert.equal(store.vulnerabilityCheck(app)!.snapshotReadAt, store.dependencySnapshots().get(app)!.readAt);
    }
    assert.equal(store.getHistory(app).filter(h => h.action === 'dependencies_read').length, before + 2);
  });
});

test('再照会の読み直しでフォルダが消えていたら古い依存を送らず前回の結果を保持する', async () => {
  await setup(async ({ root, store, call, ids, sent }) => {
    const [app] = ids;
    assert.equal((await runCheck(call, [app])).status, 'done');
    const previous = store.vulnerabilityCheck(app); sent.length = 0;
    await rm(join(root, 'app'), { recursive: true });
    const job = await runCheck(call, [app]);
    assert.equal(job.status, 'failed'); assert.match(job.error, /依存情報を読み直せません/);
    assert.deepEqual(sent, []); assert.deepEqual(store.vulnerabilityCheck(app), previous);
  });
});
