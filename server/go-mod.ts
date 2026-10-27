import { posix } from 'node:path';
import type { ParsedLock } from './npm-lock.js';
import type { Dependency } from '../shared/types.js';

// Reads go.mod as data. The go command is never run, and go.sum is not read: it lists checksums, including modules the build no longer uses.
// From Go 1.17 (module graph pruning), go.mod lists every module the main module's packages and tests need, marking the indirect ones.

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1');
// A replacement on disk rather than a module version: ./dir, ../dir, or an absolute path.
const localPath = (path: string) => /^(\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(path) || path === '.' || path === '..';

/** go 1.16, go 1.21.0, go 1.22rc1 -> [1, 16] etc. null when absent or unreadable. */
function goVersion(value: string | undefined) {
  const m = value?.match(/^(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] as const : null;
}

export function parseGoMod(text: string, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'go.mod');
  const format = 'Go modules';
  let module: string | null = null; let go: string | undefined;
  const requires: { path: string; version: string; indirect: boolean }[] = [];
  // Replacements by old path, for one version or (version '') all of them.
  const replaces = new Map<string, { local: boolean; path: string; version: string | null }>();
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const indirect = /\/\/\s*indirect\b/.test(raw);
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block && line === ')') { block = null; continue; }
    const opened: RegExpMatchArray | null = block ? null : line.match(/^(\w+)\s*\($/);
    if (opened) { block = opened[1]; continue; }
    const [verb, rest] = block ? [block, line] : [line.split(/\s+/)[0], line.slice(line.split(/\s+/)[0].length).trim()];
    const tokens = rest.split(/\s+/).map(unquote);
    if (verb === 'module') module = tokens[0] || null;
    else if (verb === 'go') go = tokens[0];
    else if (verb === 'require' && tokens.length >= 2) requires.push({ path: tokens[0], version: tokens[1], indirect });
    else if (verb === 'replace') {
      const arrow = tokens.indexOf('=>');
      if (arrow < 1) continue;
      const [oldPath, oldVersion = ''] = tokens.slice(0, arrow); const [newPath, newVersion] = tokens.slice(arrow + 1);
      if (!newPath) continue;
      replaces.set(`${oldPath}@${oldVersion}`, { local: localPath(newPath), path: newPath, version: newVersion ?? null });
    }
  }
  if (!module) return { status: 'invalid', message: 'module の宣言がありません', lockfileVersion: null, format, dependencies: [], members: [] };

  const dependencies: Dependency[] = [];
  for (const { path, version, indirect } of requires) {
    const replaced = replaces.get(`${path}@${version}`) ?? replaces.get(`${path}@`);
    const common = { ecosystem: 'Go' as const, requested: indirect ? null : version, direct: !indirect, scope: 'unknown' as const, file, component: lockDir };
    // A local replacement is never fetched; a module replacement is what the build uses, so it is the one recorded.
    if (replaced?.local) dependencies.push({ ...common, name: path, version: version.replace(/^v/, ''), source: 'file' });
    else if (replaced) dependencies.push({ ...common, name: replaced.path, version: replaced.version?.replace(/^v/, '') ?? null, source: replaced.version ? 'registry-unrecorded' : 'unknown' });
    // Modules come from the configured GOPROXY or straight from their repository; go.mod does not record which.
    else dependencies.push({ ...common, name: path, version: version.replace(/^v/, ''), source: 'registry-unrecorded' });
  }
  const v = goVersion(go);
  if (!v || v[0] < 1 || (v[0] === 1 && v[1] < 17)) {
    return { status: 'direct-only', message: `${go ? `go ${go}` : 'go の版の指定がない'} go.mod は、間接依存をすべては記載しません（Go 1.17 から記載）。記載のない間接依存は照会しません`, lockfileVersion: null, format, dependencies, members: [] };
  }
  return { status: 'ok', message: '', lockfileVersion: null, format, dependencies, members: [] };
}
