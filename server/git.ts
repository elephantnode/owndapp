import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitObservation, GitRemote, GitStatus } from '../shared/types.js';
import { within } from './scanner.js';

const fileLimit = 1024 * 1024;

async function readFile(path: string, max = fileLimit) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('unreadable');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error('unreadable');
    if (info.size > max) throw new Error('too-large');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > max) throw new Error('too-large');
    return text;
  } finally { await handle.close(); }
}

/** Removes userinfo from http(s) URLs so tokens never sit in the catalog. Other forms are left as written. */
export function sanitizeRemoteUrl(url: string) {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return trimmed;
  } catch {
    return trimmed.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
  }
}

/** Remotes from a Git config file. Only name and url are kept. */
export function parseRemotes(config: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  let current: string | null = null;
  let url: string | null = null;
  const finish = () => {
    if (current && url !== null) remotes.push({ name: current, url: sanitizeRemoteUrl(url) });
    current = null; url = null;
  };
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const section = line.match(/^\[\s*remote\s+"([^"\]]+)"\s*\]$/i);
    if (section) { finish(); current = section[1]; url = null; continue; }
    if (/^\[/.test(line)) { finish(); continue; }
    if (!current) continue;
    const pair = line.match(/^url\s*=\s*(.+)$/i);
    if (pair) url = pair[1].trim();
  }
  finish();
  return remotes;
}

export function parseHead(head: string): { branch: string | null; detached: boolean } {
  const text = head.trim();
  const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/i);
  if (ref) return { branch: ref[1], detached: false };
  if (/^[0-9a-f]{4,40}$/i.test(text)) return { branch: null, detached: true };
  return { branch: null, detached: false };
}

type GitDirs = { workTree: string; gitDir: string; commonDir: string };

/** Finds the nearest .git above projectPath and resolves worktree / common dirs without calling git. */
export async function resolveGitDirs(projectPath: string): Promise<GitDirs | null> {
  let cursor = resolve(projectPath);
  for (let i = 0; i < 64; i++) {
    const marker = join(cursor, '.git');
    try {
      const info = await lstat(marker);
      if (info.isDirectory()) {
        return { workTree: cursor, gitDir: marker, commonDir: marker };
      }
      if (info.isFile()) {
        const text = await readFile(marker, 64 * 1024);
        const match = text.match(/^\s*gitdir:\s*(.+)\s*$/im);
        if (!match) return null;
        const gitDir = isAbsolute(match[1].trim()) ? resolve(match[1].trim()) : resolve(cursor, match[1].trim());
        let commonDir = gitDir;
        try {
          const common = (await readFile(join(gitDir, 'commondir'), 4 * 1024)).trim();
          commonDir = isAbsolute(common) ? resolve(common) : resolve(gitDir, common);
        } catch { /* bare worktree pointer without commondir uses gitDir itself */ }
        return { workTree: cursor, gitDir, commonDir };
      }
    } catch { /* no .git here */ }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function displayRoot(projectPath: string, workTree: string) {
  const root = resolve(projectPath);
  const tree = resolve(workTree);
  // Prefer a path relative to the project when the repo root is the project or an ancestor/descendant.
  if (root === tree || within(root, tree) || within(tree, root)) {
    const rel = relative(root, tree);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return tree;
}

function observation(projectId: string, status: GitStatus, partial: Partial<GitObservation> = {}): Omit<GitObservation, 'projectId' | 'readAt'> & { status: GitStatus } {
  return {
    status,
    gitRoot: null,
    branch: null,
    detached: false,
    remotes: [],
    ...partial,
  };
}

/**
 * Reads branch and remotes from the enclosing Git repository of the project folder.
 * Files only; no git CLI, no network, no status/dirty/upstream.
 */
export async function readGit(projectId: string, projectPath: string): Promise<Omit<GitObservation, 'readAt'> & { readAt?: never }> {
  const dirs = await resolveGitDirs(projectPath);
  if (!dirs) return { projectId, ...observation(projectId, 'no-git', { message: 'Git管理のフォルダではありません' }) };

  const gitRoot = displayRoot(projectPath, dirs.workTree);
  try {
    // Confirm the git directories still resolve; broken links become unreadable.
    await realpath(dirs.gitDir).catch(() => { throw new Error('unreadable'); });
    const headText = await readFile(join(dirs.gitDir, 'HEAD'), 64 * 1024);
    const { branch, detached } = parseHead(headText);
    let remotes: GitRemote[] = [];
    let message: string | undefined;
    try {
      remotes = parseRemotes(await readFile(join(dirs.commonDir, 'config')));
    } catch (error) {
      const reason = (error as Error).message;
      if (reason === 'too-large') return { projectId, ...observation(projectId, 'invalid', { gitRoot, message: 'Gitの設定ファイルが大きすぎます' }) };
      return { projectId, ...observation(projectId, 'unreadable', { gitRoot, branch, detached, message: 'Gitの設定を読み取れません' }) };
    }
    if (!remotes.length) message = 'リモートは設定されていません';
    return { projectId, status: 'ok', gitRoot, branch, detached, remotes, message };
  } catch (error) {
    const reason = (error as Error).message;
    if (reason === 'too-large') return { projectId, ...observation(projectId, 'invalid', { gitRoot, message: 'GitのHEADが大きすぎます' }) };
    return { projectId, ...observation(projectId, 'unreadable', { gitRoot, message: 'Gitの情報を読み取れません。権限やパスを確認してください' }) };
  }
}
