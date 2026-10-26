import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';

// Windows root-relative paths (\\folder) and drive-relative paths (C:folder) depend on cwd; require a full drive or UNC share.
export function absoluteFolder(path: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return posix.isAbsolute(path);
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('//?/') || normalized.startsWith('//./')) return false;
  return /^[a-z]:\//i.test(normalized) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized);
}
export function folderInput(input: string, platform: NodeJS.Platform = process.platform, home = homedir()) {
  let path = input.trim();
  if (platform === 'win32' && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  const paths = platform === 'win32' ? win32 : posix;
  if (path === '~') path = home;
  else if (path.startsWith('~/') || platform === 'win32' && path.startsWith('~\\')) path = paths.join(home, path.slice(2));
  if (!absoluteFolder(path, platform)) throw new Error('探索するフォルダを絶対パスで入力してください');
  return path;
}
export function pathWithin(root: string, target: string, platform: NodeJS.Platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const rel = paths.relative(root, target);
  return rel === '' || (!paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`));
}
