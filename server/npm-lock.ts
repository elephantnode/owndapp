
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { Dependency, DependencyScope, DependencySource, LockFileStatus } from '../shared/types.js';

// Reads npm lockfiles as data. Nothing in the project is installed, run, or evaluated, and no file is written.
const sections = [['dependencies', 'prod'], ['devDependencies', 'dev'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']] as const;

export function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export const text = (value: unknown) => typeof value === 'string' ? value : null;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Declared name -> range, from every dependency section of a manifest. Peer ranges are kept but never count toward a mismatch. */
export function declared(manifest: Record<string, any>, includePeer = true) {
  return new Map([...declaredScopes(manifest, includePeer)].map(([name, { range }]) => [name, range]));
}
/** Declared name -> range and the section's scope. The first section wins when a name is declared twice. */
export function declaredScopes(manifest: Record<string, any>, includePeer = true) {
  const result = new Map<string, { range: string; scope: DependencyScope }>();
  for (const [section, scope] of sections) {
    if (section === 'peerDependencies' && !includePeer) continue;
    for (const [name, range] of Object.entries(object(manifest[section]))) if (!result.has(name) && typeof range === 'string') result.set(name, { range, scope });
  }
  return result;
}

export function classifySource(resolved: string | null, version: string | null): DependencySource {
  // Yarn v1 appends the hash to resolved URLs (#sha1). It is not part of where the package came from.
  const value = (resolved || version || '').replace(/#[0-9a-f]+$/i, '');
  if (/^file:/.test(value)) return 'file';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(value) || /^git\+/.test(version || '')) return 'git';
  if (/^https?:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//.test(value)) return 'registry';
  if (/^https?:\/\/.+\/-\/[^/]+\.tgz(\?.*)?$/.test(value)) return 'other-registry';
  if (/^https?:\/\//.test(value)) return 'url';
  if (!resolved && version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) return 'registry-unrecorded';
  return 'unknown';
}

function scopeOf(entry: Record<string, any>): DependencyScope {
  if (entry.dev || entry.devOptional) return 'dev';
  if (entry.optional) return 'optional';
  if (entry.peer) return 'peer';
  return 'prod';
}

// npm:real@1.2.3 aliases record the real package. Search by the real name, as advisories do.
function unalias(name: string, version: string | null) {
  const alias = version?.match(/^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/);
  return alias ? { name: alias[1], version: alias[2] } : { name, version };
}

/** members: folders relative to the project that the lockfile covers as workspace members, so they are not reported as having no lockfile. */
export interface ParsedLock { status: LockFileStatus; message: string; lockfileVersion: number | null; format: string; dependencies: Dependency[]; members: string[] }

/**
 * Parses one npm lockfile. lockDir is the lockfile's folder relative to the project ('' for the project itself).
 * members lists workspace folders (relative to the project) the lockfile covers.
 */
export function parseNpmLock(lockText: string, manifestText: string | null, lockDir: string, lockName = 'package-lock.json'): ParsedLock {
  const file = posix.join(lockDir, lockName);
  let lock: Record<string, any>;
  try { lock = object(JSON.parse(lockText)); } catch { return { status: 'invalid', message: 'JSONとして読み取れません', lockfileVersion: null, format: 'npm', dependencies: [], members: [] }; }
  const lockfileVersion = Number.isInteger(lock.lockfileVersion) ? lock.lockfileVersion as number : null;
  if (lockfileVersion === null || ![1, 2, 3].includes(lockfileVersion)) {
    return { status: 'unsupported', message: `lockfileVersion ${lockfileVersion ?? '不明'} は未対応です`, lockfileVersion, format: 'npm', dependencies: [], members: [] };
  }
  let manifest: Record<string, any> | null = null;
  if (manifestText !== null) { try { manifest = object(JSON.parse(manifestText)); } catch { manifest = null; } }
  const rows = new Map<string, Dependency>();
  const push = (dependency: Dependency) => {
    const key = [dependency.name, dependency.version, dependency.component, dependency.direct, dependency.scope, dependency.source].join('\0');
    if (!rows.has(key)) rows.set(key, dependency);
  };
  const component = (inLock: string) => posix.join(lockDir, inLock).replace(/^\.$/, '');
  const members: string[] = [];
  let lockDeclared: Map<string, string>;

  if (lockfileVersion === 1) {
    const top = object(lock.dependencies);
    if (!Object.keys(top).length && Object.keys(object(lock.packages)).length) {
      return { status: 'invalid', message: 'lockfileVersion 1 ですが dependencies がありません', lockfileVersion, format: 'npm', dependencies: [], members: [] };
    }
    const root = manifest ? declared(manifest) : new Map<string, string>();
    const walk = (tree: Record<string, any>, depth: number) => {
      for (const [key, value] of Object.entries(tree)) {
        const entry = object(value);
        const real = unalias(key, text(entry.version));
        const direct = depth === 0 && root.has(key);
        push({ ecosystem: 'npm', name: real.name, version: real.version, requested: direct ? root.get(key)! : null, direct, scope: scopeOf(entry),
          source: classifySource(text(entry.resolved), text(entry.version)), file, component: lockDir });
        walk(object(entry.dependencies), depth + 1);
      }
    };
    walk(top, 0);
    lockDeclared = new Map(Object.keys(top).filter(name => root.has(name)).map(name => [name, root.get(name)!]));
  } else {
    const packages = object(lock.packages);
    if (!Object.keys(packages).length) return { status: 'invalid', message: 'packages がありません', lockfileVersion, format: 'npm', dependencies: [], members: [] };
    // Keys without node_modules are the root ('') and workspace members. Their entries hold what each one declares.
    const memberDeclared = new Map<string, Map<string, string>>();
    for (const [key, value] of Object.entries(packages)) {
      if (key.split('/').includes('node_modules')) continue;
      memberDeclared.set(key, declared(object(value)));
      if (key) members.push(component(key));
    }
    for (const [key, value] of Object.entries(packages)) {
      // Keys look like [owner/]node_modules/a[/node_modules/b...]. owner is '' or a workspace member folder.
      const segments = key.split('/');
      const first = segments.indexOf('node_modules');
      if (first < 0) continue;
      const entry = object(value);
      if (entry.link) continue; // A link to a workspace member, which is listed as a member instead.
      const owner = segments.slice(0, first).join('/');
      const last = segments.lastIndexOf('node_modules');
      const folderName = segments.slice(last + 1).join('/'); // The name used in node_modules, which is the alias for npm: aliases.
      const nested = last !== first;
      // A first-level package is direct when its folder's owner declares it. Hoisted packages ('') may be declared by any member.
      let requested: string | null = null;
      if (!nested) {
        requested = memberDeclared.get(owner)?.get(folderName) ?? null;
        if (requested === null && owner === '') for (const map of memberDeclared.values()) { if (map.has(folderName)) { requested = map.get(folderName)!; break; } }
      }
      push({ ecosystem: 'npm', name: text(entry.name) || folderName, version: text(entry.version), requested, direct: requested !== null, scope: scopeOf(entry),
        source: classifySource(text(entry.resolved), text(entry.version)), file, component: component(owner) });
    }
    lockDeclared = declared(object(packages['']), false);
  }

  const dependencies = [...rows.values()];
  if (!manifest) {
    return { status: 'mismatch', message: manifestText === null ? '同じ場所に package.json がありません' : 'package.json を読み取れないため、宣言との対応は未確認です', lockfileVersion, format: `npm v${lockfileVersion}`, dependencies, members };
  }
  // Compare names and ranges, ignoring peers. A difference means the lockfile may be older than package.json.
  const expected = declared(manifest, false);
  const differs = [...expected].filter(([name, range]) => lockfileVersion === 1 ? !lockDeclared.has(name) : lockDeclared.get(name) !== range)
    .concat(lockfileVersion === 1 ? [] : [...lockDeclared].filter(([name]) => !expected.has(name)));
  if (differs.length) {
    const names = differs.slice(0, 3).map(([name]) => name).join('、');
    return { status: 'mismatch', message: `package.json の宣言と lock が一致しません（${names}${differs.length > 3 ? ' ほか' : ''}）。lock が古い可能性があります`, lockfileVersion, format: `npm v${lockfileVersion}`, dependencies, members };
  }
  return { status: 'ok', message: '', lockfileVersion, format: `npm v${lockfileVersion}`, dependencies, members };
}
