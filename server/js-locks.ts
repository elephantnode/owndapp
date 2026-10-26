import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classifySource, declaredScopes, object, text, type ParsedLock } from './npm-lock.js';
import type { Dependency, DependencyScope, DependencySource } from '../shared/types.js';

// Reads Yarn and pnpm lockfiles as data, like npm-lock.ts. Both are npm packages, so the ecosystem is npm.
// manifests maps folders relative to the project ('' is the project) to their package.json text, for the lock's folder
// and the folders below it. They tell which dependencies are direct and which folders are workspace members.

type Manifests = Map<string, string>;
type Declared = Map<string, { range: string; scope: DependencyScope }>;
const local = /^(workspace|link|portal):/;

function parseManifest(value: string | undefined) { try { return value === undefined ? null : object(JSON.parse(value)); } catch { return null; } }
const relative = (lockDir: string, folder: string) => lockDir ? posix.relative(lockDir, folder) : folder;

// Workspace globs such as packages/* or apps/**. Negated patterns are ignored; a member they exclude is merely read twice.
function globMatch(patterns: string[], path: string) {
  return patterns.some(pattern => {
    if (pattern.startsWith('!')) return false;
    const source = pattern.replace(/^\.\//, '').replace(/\/$/, '').split(/(\*\*|\*)/).map(part => part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${source}$`).test(path);
  });
}
function workspacePatterns(manifest: Record<string, any> | null): string[] {
  const value = manifest?.workspaces;
  const list = Array.isArray(value) ? value : object(value).packages;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/** The folders a lockfile covers: its own and the declared members, each with what it declares. */
function owners(lockDir: string, manifests: Manifests, members: string[]) {
  const declared = new Map<string, Declared>();
  for (const folder of [lockDir, ...members]) {
    const manifest = parseManifest(manifests.get(folder));
    if (manifest) declared.set(folder, declaredScopes(manifest));
  }
  return declared;
}

// "name@range": the name may be scoped (@scope/name), so the separator is the first @ after the first character.
function splitSpec(spec: string) {
  const at = spec.indexOf('@', 1);
  return at < 0 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

function finish(format: string, dependencies: Dependency[], members: string[], expected: [string, string][], found: (name: string, range: string) => boolean, manifestFound: boolean): ParsedLock {
  if (!manifestFound) return { status: 'mismatch', message: '同じ場所の package.json を読み取れないため、宣言との対応は未確認です', lockfileVersion: null, format, dependencies, members };
  const differs = expected.filter(([name, range]) => !local.test(range) && !found(name, range));
  if (differs.length) {
    const names = differs.slice(0, 3).map(([name]) => name).join('、');
    return { status: 'mismatch', message: `package.json の宣言と lock が一致しません（${names}${differs.length > 3 ? ' ほか' : ''}）。lock が古い可能性があります`, lockfileVersion: null, format, dependencies, members };
  }
  return { status: 'ok', message: '', lockfileVersion: null, format, dependencies, members };
}
const expectedOf = (declared: Map<string, Declared>) => [...declared.values()].flatMap(map => [...map].filter(([, d]) => d.scope !== 'peer').map(([name, d]) => [name, d.range] as [string, string]));

/** Yarn v1 lockfiles: blocks keyed by one or more "name@range" specs, each holding version and resolved. */
function yarnClassic(lockText: string) {
  const entries: { specs: string[]; version: string | null; resolved: string | null }[] = [];
  let current: (typeof entries)[number] | null = null;
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
  for (const line of lockText.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { specs: line.replace(/:\s*$/, '').split(/,\s*/).map(unquote), version: null, resolved: null };
      entries.push(current); continue;
    }
    const field = line.match(/^ {2}(version|resolved) (.+)$/);
    if (current && field) current[field[1] as 'version' | 'resolved'] = unquote(field[2]);
  }
  return entries;
}

// What a Yarn 2+ resolution such as "lodash@npm:4.17.21" says about the origin. Registries are not recorded in these lockfiles.
function berrySource(resolution: string): DependencySource {
  const { range } = splitSpec(resolution);
  if (range.startsWith('npm:') || (range.startsWith('patch:') && /npm%3A/.test(range))) return 'registry-unrecorded';
  if (/^(file|link|portal|exec):/.test(range)) return 'file';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(range) || /\.git(#|$)/.test(range)) return 'git';
  if (/^https?:/.test(range)) return 'url';
  return 'unknown';
}

export function parseYarnLock(lockText: string, manifests: Manifests, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'yarn.lock');
  const root = parseManifest(manifests.get(lockDir));
  const berry = /^__metadata:/m.test(lockText);
  const format = berry ? 'Yarn 2+' : 'Yarn v1';
  type Entry = { specs: string[]; name: string; version: string | null; source: DependencySource };
  let entries: Entry[] = []; let members: string[] = [];
  if (berry) {
    let lock: Record<string, any>;
    try { lock = object(parseYaml(lockText, { maxAliasCount: -1 })); } catch { return { status: 'invalid', message: 'YAMLとして読み取れません', lockfileVersion: null, format, dependencies: [], members: [] }; }
    for (const [key, value] of Object.entries(lock)) {
      if (key === '__metadata') continue;
      const entry = object(value); const resolution = text(entry.resolution) || '';
      const specs = key.split(/,\s*/);
      // Workspace entries are the project and its members, not dependencies.
      const workspace = resolution.match(/@workspace:(.+)$/);
      if (workspace) { if (workspace[1] !== '.') members.push(posix.join(lockDir, workspace[1])); continue; }
      entries.push({ specs, name: splitSpec(resolution).name || splitSpec(specs[0]).name, version: text(entry.version), source: berrySource(resolution) });
    }
  } else {
    if (!/^# yarn lockfile v1/m.test(lockText)) return { status: 'unsupported', message: 'yarn.lock の形式を判別できません', lockfileVersion: null, format, dependencies: [], members: [] };
    for (const entry of yarnClassic(lockText)) {
      // An npm: alias records the real package name in its range.
      const { name, range } = splitSpec(entry.specs[0]);
      const real = range.match(/^npm:((?:@[^/@]+\/)?[^@]+)@/)?.[1] ?? name;
      // file: and git dependencies may have no resolved URL; their range says where they came from.
      const hint = /^[a-z+]+:/.test(range) && !range.startsWith('npm:') ? range : entry.version;
      entries.push({ specs: entry.specs, name: real, version: entry.version, source: classifySource(entry.resolved, hint) });
    }
    const patterns = workspacePatterns(root);
    members = [...manifests.keys()].filter(folder => folder !== lockDir && patterns.length > 0 && globMatch(patterns, relative(lockDir, folder)));
  }
  const declared = owners(lockDir, manifests, members);
  // Spec as written in package.json: Yarn 2+ adds the npm: protocol to plain ranges.
  const specOf = (name: string, range: string) => berry && !/^[a-z]+:/.test(range) ? [`${name}@npm:${range}`, `${name}@${range}`] : [`${name}@${range}`];
  const rows: Dependency[] = []; const specs = new Set<string>();
  for (const entry of entries) {
    entry.specs.forEach(spec => specs.add(spec));
    let direct = false;
    for (const [folder, map] of declared) {
      for (const [name, { range, scope }] of map) {
        if (!specOf(name, range).some(spec => entry.specs.includes(spec))) continue;
        direct = true;
        rows.push({ ecosystem: 'npm', name: entry.name, version: entry.version, requested: range, direct: true, scope, source: entry.source, file, component: folder });
      }
    }
    if (!direct) rows.push({ ecosystem: 'npm', name: entry.name, version: entry.version, requested: null, direct: false, scope: 'unknown', source: entry.source, file, component: lockDir });
  }
  return finish(format, rows, members, expectedOf(declared), (name, range) => specOf(name, range).some(spec => specs.has(spec)), !!root);
}

// pnpm package keys: v5 "/name/1.2.3_peer", v6 "/name@1.2.3(peer)", v9 "name@1.2.3(peer)". Scoped names keep their @.
function pnpmKey(key: string, major: number) {
  const bare = key.replace(/^\//, '').replace(/\(.*$/, '');
  if (major < 6) {
    const slash = bare.lastIndexOf('/');
    return slash < 0 ? { name: bare, version: null } : { name: bare.slice(0, slash), version: bare.slice(slash + 1).replace(/_.*$/, '') };
  }
  const { name, range } = splitSpec(bare);
  return { name, version: range || null };
}
function pnpmSource(entry: Record<string, any>): DependencySource {
  const resolution = object(entry.resolution);
  if (resolution.type === 'git' || resolution.repo) return 'git';
  if (resolution.directory) return 'file';
  if (typeof resolution.tarball === 'string') return classifySource(resolution.tarball, text(entry.version));
  if (resolution.integrity) return 'registry-unrecorded';
  return 'unknown';
}

export function parsePnpmLock(lockText: string, manifests: Manifests, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'pnpm-lock.yaml');
  let lock: Record<string, any>;
  try { lock = object(parseYaml(lockText, { maxAliasCount: -1 })); } catch { return { status: 'invalid', message: 'YAMLとして読み取れません', lockfileVersion: null, format: 'pnpm', dependencies: [], members: [] }; }
  const version = String(lock.lockfileVersion ?? '');
  const major = Number.parseFloat(version);
  const format = `pnpm ${version || '不明'}`;
  if (!Number.isFinite(major) || major < 5 || major >= 10) return { status: 'unsupported', message: `lockfileVersion ${version || '不明'} は未対応です`, lockfileVersion: null, format, dependencies: [], members: [] };
  // A single project without a workspace keeps its sections at the top level (v5, v6).
  const importers = Object.keys(object(lock.importers)).length ? object(lock.importers) : { '.': lock };
  const members = Object.keys(importers).filter(key => key !== '.').map(key => posix.join(lockDir, key));
  const packages = new Map<string, { name: string; version: string | null; source: DependencySource; scope: DependencyScope }>();
  for (const [key, value] of Object.entries(object(lock.packages))) {
    const entry = object(value); const parsed = pnpmKey(key, major);
    const scope: DependencyScope = entry.dev === true ? 'dev' : entry.optional === true ? 'optional' : entry.dev === false ? 'prod' : 'unknown';
    packages.set(key.replace(/\(.*$/, ''), { name: text(entry.name) || parsed.name, version: text(entry.version) || parsed.version, source: pnpmSource(entry), scope });
  }
  // Finds the package an importer's version points to. Versions may carry peers, or name another package for aliases.
  const lookup = (name: string, value: string) => {
    const bare = value.replace(/\(.*$/, '').replace(/_.*$/, '');
    const alias = bare.match(/^\/?((?:@[^/@]+\/)?[^@/]+)@(\d.*)$/);
    const [realName, realVersion] = alias ? [alias[1], alias[2]] : [name, bare];
    const keys = bare.startsWith('/') || bare.includes('/') && !alias ? [bare, `/${bare}`, `${name}@${bare}`]
      : major < 6 ? [`/${realName}/${realVersion}`] : major < 9 ? [`/${realName}@${realVersion}`] : [`${realName}@${realVersion}`];
    for (const key of keys) { const found = packages.get(key); if (found) return { key, ...found }; }
    return null;
  };
  const sectionScopes = [['dependencies', 'prod'], ['devDependencies', 'dev'], ['optionalDependencies', 'optional']] as const;
  const rows: Dependency[] = []; const directKeys = new Set<string>(); const specifiers = new Map<string, Map<string, string>>();
  for (const [importer, value] of Object.entries(importers)) {
    const entry = object(value); const folder = posix.join(lockDir, importer).replace(/^\.$/, '');
    const named = new Map<string, string>(); specifiers.set(folder, named);
    for (const [section, scope] of sectionScopes) {
      for (const [name, raw] of Object.entries(object(entry[section]))) {
        // v6 and later: { specifier, version }. v5: the version, with ranges under specifiers.
        const version = typeof raw === 'string' ? raw : text(object(raw).version) || '';
        const specifier = typeof raw === 'string' ? text(object(entry.specifiers)[name]) : text(object(raw).specifier);
        if (specifier) named.set(name, specifier);
        if (/^link:/.test(version)) continue; // A workspace member, listed as a member instead.
        const found = lookup(name, version);
        if (found) directKeys.add(found.key);
        rows.push({ ecosystem: 'npm', name: found?.name ?? name, version: found?.version ?? (/^\d/.test(version) ? version.replace(/[(_].*$/, '') : null), requested: specifier,
          direct: true, scope, source: found?.source ?? (/^file:/.test(version) ? 'file' : 'unknown'), file, component: folder });
      }
    }
  }
  for (const [key, entry] of packages) {
    if (directKeys.has(key)) continue;
    rows.push({ ecosystem: 'npm', name: entry.name, version: entry.version, requested: null, direct: false, scope: entry.scope, source: entry.source, file, component: lockDir });
  }
  // Compares package.json with the lock's specifiers, the way the npm reader compares with its root entry.
  const declared = owners(lockDir, manifests, members);
  return finish(format, rows, members, expectedOf(declared).filter(([name]) => name), (name, range) =>
    [...specifiers.values()].some(map => map.get(name) === range), !!parseManifest(manifests.get(lockDir)));
}
