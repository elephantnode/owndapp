import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { parseHead, parseRemotes, readGit, sanitizeRemoteUrl } from '../server/git.js';
import { Store } from '../server/store.js';
import { createApi } from '../server/api.js';
import type { Candidate, Project } from '../shared/types.js';

async function fixture(fn: (root: string, put: (file: string, data: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'owndapp-git-'));
  const put = async (file: string, data: string) => {
    const { dirname } = await import('node:path');
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), data);
  };
  try { await fn(await canonicalRoot(root), put); } finally { await rm(root, { recursive: true, force: true }); }
}

const candidate = (path: string): Candidate => ({
  id: 'c', path, name: 'example', technologies: [], components: [],
  evidence: [{ file: '.git', detail: 'Git' }], fingerprint: 'h', registered: false,
});

function client(store: Store) {
  const api = createApi(store, 4310);
  let token = '';
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await api.request(`http://127.0.0.1:4310/api${path}`, {
      method: body === undefined ? 'GET' : method,
      headers: { host: '127.0.0.1:4310', 'x-owndapp-client': 'web', 'x-owndapp-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as any;
    if (path === '/session' && data.token) token = data.token;
    return { response, data };
  };
  return { call };
}

test('remote URLの認証情報を除き、configとHEADを解釈する', () => {
  assert.equal(sanitizeRemoteUrl('https://user:token@github.com/org/repo.git'), 'https://github.com/org/repo.git');
  assert.equal(sanitizeRemoteUrl('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
  assert.deepEqual(parseHead('ref: refs/heads/main\n'), { branch: 'main', detached: false });
  assert.deepEqual(parseHead('abcdef0123456789abcdef0123456789abcdef01\n'), { branch: null, detached: true });
  assert.deepEqual(parseRemotes(`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://user:secret@github.com/a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "upstream"]\n\turl = git@github.com:up/stream.git\n`),
    [{ name: 'origin', url: 'https://github.com/a/b.git' }, { name: 'upstream', url: 'git@github.com:up/stream.git' }]);
  assert.deepEqual(parseRemotes('[core]\n\tbare = false\n'), []);
});

test('通常のリポジトリ・リモートなし・Gitなし・worktree風gitdirを読む', async () => {
  await fixture(async (root, put) => {
    await put('repo/.git/HEAD', 'ref: refs/heads/develop\n');
    await put('repo/.git/config', '[remote "origin"]\n\turl = https://token@example.com/app.git\n');
    await put('repo/package.json', '{"name":"app"}');
    const withRemote = await readGit('p1', join(root, 'repo'));
    assert.equal(withRemote.status, 'ok');
    assert.equal(withRemote.branch, 'develop');
    assert.equal(withRemote.detached, false);
    assert.equal(withRemote.gitRoot, '.');
    assert.deepEqual(withRemote.remotes, [{ name: 'origin', url: 'https://example.com/app.git' }]);

    await put('local/.git/HEAD', 'ref: refs/heads/main\n');
    await put('local/.git/config', '[core]\n\trepositoryformatversion = 0\n');
    const noRemote = await readGit('p2', join(root, 'local'));
    assert.equal(noRemote.status, 'ok');
    assert.equal(noRemote.remotes.length, 0);
    assert.match(noRemote.message || '', /リモート/);

    const none = await readGit('p3', join(root, 'plain'));
    assert.equal(none.status, 'no-git');

    // worktree-style: .git file points at a gitdir that has HEAD; remotes live in commondir.
    await put('main/.git/HEAD', 'ref: refs/heads/main\n');
    await put('main/.git/config', '[remote "origin"]\n\turl = https://example.com/main.git\n');
    await put('main/.git/worktrees/feature/HEAD', 'ref: refs/heads/feature\n');
    await put('main/.git/worktrees/feature/commondir', '../..\n');
    await put('feature/.git', `gitdir: ${join(root, 'main/.git/worktrees/feature')}\n`);
    await put('feature/package.json', '{"name":"feature"}');
    const worktree = await readGit('p4', join(root, 'feature'));
    assert.equal(worktree.status, 'ok');
    assert.equal(worktree.branch, 'feature');
    assert.deepEqual(worktree.remotes, [{ name: 'origin', url: 'https://example.com/main.git' }]);
    assert.equal(worktree.gitRoot, '.');
  });
});

test('祖先の.gitを辿り、壊れたconfigはinvalid/unreadableとして返す', async () => {
  await fixture(async (root, put) => {
    await put('mono/.git/HEAD', 'ref: refs/heads/trunk\n');
    await put('mono/.git/config', '[remote "origin"]\n\turl = https://example.com/mono.git\n');
    await put('mono/apps/web/package.json', '{"name":"web"}');
    const nested = await readGit('p', join(root, 'mono/apps/web'));
    assert.equal(nested.status, 'ok');
    assert.equal(nested.branch, 'trunk');
    assert.equal(nested.gitRoot, '../..');
    assert.equal(nested.remotes[0]?.name, 'origin');

    await put('bad/.git/HEAD', 'ref: refs/heads/main\n');
    // A directory named config makes the file unreadable via O_NOFOLLOW/isFile checks.
    await mkdir(join(root, 'bad/.git/config'));
    const unreadable = await readGit('bad', join(root, 'bad'));
    assert.equal(unreadable.status, 'unreadable');
  });
});

test('アーカイブ以外の全プロジェクトのGitを裏で読み、アーカイブは触らない', async () => {
  await fixture(async (root, put) => {
    await put('a/.git/HEAD', 'ref: refs/heads/main\n');
    await put('a/.git/config', '[remote "origin"]\n\turl = https://example.com/a.git\n');
    await put('a/package.json', '{"name":"a"}');
    await put('b/.git/HEAD', 'ref: refs/heads/dev\n');
    await put('b/.git/config', '[core]\n\trepositoryformatversion = 0\n');
    await put('b/package.json', '{"name":"b"}');
    await put('old/.git/HEAD', 'ref: refs/heads/old\n');
    await put('old/.git/config', '[remote "origin"]\n\turl = https://example.com/old.git\n');
    await put('old/package.json', '{"name":"old"}');
    const store = new Store(':memory:');
    try {
      const { call } = client(store);
      await call('/session');
      const wait = async () => { for (let i = 0; i < 200 && (await call('/git/progress')).data.running; i++) await new Promise(r => setTimeout(r, 5)); };
      const { projectIds } = store.import('all', [candidate(join(root, 'a')), candidate(join(root, 'b')), candidate(join(root, 'old'))]);
      const [a, b, old] = projectIds;
      store.setLifecycle([old], 'archived', '公開終了');
      assert.deepEqual((await call('/git/progress')).data, { running: false, done: 0, total: 0 });
      const all = await call('/git/read-all', {});
      assert.equal(all.data.queued, 2);
      await wait();
      assert.equal(store.gitObservation(a)?.status, 'ok');
      assert.equal(store.gitObservation(a)?.remotes.length, 1);
      assert.equal(store.gitObservation(b)?.status, 'ok');
      assert.equal(store.gitObservation(b)?.remotes.length, 0);
      assert.equal(store.gitObservation(old), null);
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === a)!.gitRemoteCount, 1);
      assert.equal(projects.find(p => p.id === a)!.gitBranch, 'main');
      assert.equal(projects.find(p => p.id === b)!.gitStatus, 'ok');
      assert.equal(projects.find(p => p.id === b)!.gitBranch, 'dev');
      assert.equal(projects.find(p => p.id === old)!.gitStatus, undefined);
    } finally { store.close(); }
  });
});

test('API: Git情報を読み、カタログ要約に載せ、外すと観測を消す', async () => {
  await fixture(async (root, put) => {
    await put('app/.git/HEAD', 'ref: refs/heads/main\n');
    await put('app/.git/config', '[remote "origin"]\n\turl = https://user:pass@github.com/o/r.git\n');
    await put('app/package.json', '{"name":"app"}');
    await put('plain/package.json', '{"name":"plain"}');
    const store = new Store(':memory:');
    try {
      const { call } = client(store);
      await call('/session');
      const { projectIds } = store.import('git', [candidate(join(root, 'app')), candidate(join(root, 'plain')), candidate(join(root, 'gone'))]);
      const [app, plain, gone] = projectIds;
      assert.equal((await call('/git/read', { ids: [] })).response.status, 400);
      const read = await call('/git/read', { ids: [app, plain, gone] });
      assert.deepEqual(read.data.results.map((r: { status: string }) => r.status), ['ok', 'no-git', 'missing']);
      const detail = (await call(`/projects/${app}/git`)).data.observation;
      assert.equal(detail.status, 'ok');
      assert.equal(detail.branch, 'main');
      assert.deepEqual(detail.remotes, [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
      assert.match(JSON.stringify(store.getHistory(app)), /git_read/);
      const projects: Project[] = (await call('/projects')).data.projects;
      assert.equal(projects.find(p => p.id === app)!.gitStatus, 'ok');
      assert.equal(projects.find(p => p.id === app)!.gitRemoteCount, 1);
      assert.equal(projects.find(p => p.id === app)!.gitBranch, 'main');
      assert.equal(projects.find(p => p.id === plain)!.gitStatus, 'no-git');
      assert.equal(projects.find(p => p.id === gone)!.gitStatus, undefined);
      await call('/projects/remove-missing', { ids: [gone] });
      // Replacing a previous read keeps credentials stripped.
      await put('app/.git/config', '[remote "origin"]\n\turl = https://example.com/new.git\n[remote "backup"]\n\turl = git@example.com:b.git\n');
      await call('/git/read', { ids: [app] });
      const again = (await call(`/projects/${app}/git`)).data.observation;
      assert.equal(again.remotes.length, 2);
      assert.ok(!JSON.stringify(again).includes('user:pass'));
      store.remove([app], 'test');
      assert.equal(store.gitObservations().size, 1); // plain remains
      assert.equal(store.gitObservation(plain)?.status, 'no-git');
    } finally { store.close(); }
  });
});
