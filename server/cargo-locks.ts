import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { object, text, type ParsedLock } from './npm-lock.js';
import { compareSemver } from '../shared/semver.js';
import type { Dependency, DependencyScope, DependencySource } from '../shared/types.js';

// Reads Cargo.lock and Cargo.toml files as TOML data. Nothing is built or run: cargo is never called, build scripts are never read,
// and cfg(...) targets and features are not evaluated. Cargo resolves the lockfile for every target and feature at once, so a row
// here only says the lockfile records the package, not that a build for some host includes it.
// manifests maps folders relative to the project ('' is the project) to Cargo.toml text: the lock's folder and the folders below it.

type Manifests = Map<string, string>;
type Kind = 'crates-io' | 'registry' | 'git' | 'path' | 'unknown';
interface Declaration { name: string; req: string | null; kind: Kind; git: string | null; path: string | null; scope: DependencyScope; requested: string | null }
interface Package { name: string; version: string; source: string | null; dependencies: string[] }

// The two spellings of crates.io that Cargo writes. Any other registry, including mirrors and lookalike hosts, is other-registry.
const cratesIo = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/']);
// crates.io names: ASCII letters, digits, - and _, starting with a letter, at most 64 characters. Local packages may also start with _.
const publicName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const localName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const note = 'Cargo.lock と Cargo.toml を静的に読んだ一覧です。インストール・配備・実行時に使われる証明ではなく、target・feature・ビルドスクリプトは評価していません';

export function cargoSource(source: string | null): DependencySource {
  if (source === null) return 'file';
  if (cratesIo.has(source)) return 'registry';
  if (/^(registry|sparse)\+/.test(source)) return 'other-registry';
  if (source.startsWith('git+')) return 'git';
  return 'unknown';
}

function parse(value: string | undefined) { try { return value === undefined ? null : object(parseToml(value)); } catch { return null; } }
const result = (status: ParsedLock['status'], message: string, lockfileVersion: number | null, dependencies: Dependency[] = [], members: string[] = []): ParsedLock =>
  ({ status, message, lockfileVersion, format: lockfileVersion ? `Cargo v${lockfileVersion}` : 'Cargo', dependencies, members });
const list = (items: string[]) => `${items.slice(0, 3).join('、')}${items.length > 3 ? ' ほか' : ''}`;

// A relative path whose every segment is a real name: no empty, '.', or '..' segments, no absolute paths or backslashes.
const safe = (path: string) => path !== '' && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(s => s && s !== '.' && s !== '..');
function below(lockDir: string, folder: string) {
  if (lockDir && !folder.startsWith(`${lockDir}/`)) return null;
  const rel = lockDir ? folder.slice(lockDir.length + 1) : folder;
  return safe(rel) ? rel : null;
}
/** A path written in a manifest at base, relative to the project. null when it leaves the project. */
function resolvePath(base: string, path: string) {
  if (path.startsWith('/') || path.includes('\\')) return null;
  const joined = posix.normalize(posix.join(base || '.', path)).replace(/\/$/, '');
  if (joined === '.') return '';
  return joined === '..' || joined.startsWith('../') ? null : joined;
}

// Workspace members globs as Cargo's glob crate reads them, one path segment at a time: * and ? stay within a segment, ** spans segments.
// Patterns with character classes, braces, or segments that leave the workspace are not understood, so they cover nothing.
function globSegments(pattern: string) {
  const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!safe(p) || /[[\]{}!]/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some(s => s.includes('**') && s !== '**')) return null;
  return segments.map(s => s === '**' ? s : new RegExp(`^${s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`));
}
function globMatch(pattern: (RegExp | '**')[], path: string[]): boolean {
  if (!pattern.length) return !path.length;
  const [head, ...rest] = pattern;
  if (head === '**') return path.some((_, i) => globMatch(rest, path.slice(i))) || globMatch(rest, []);
  return path.length > 0 && head.test(path[0]) && globMatch(rest, path.slice(1));
}

/** Folders the root manifest's [workspace] covers through members, minus exclude, which Cargo applies as path prefixes. */
function workspaceMembers(lockDir: string, root: Record<string, any>, manifests: Manifests) {
  if (!('workspace' in root)) return [];
  const workspace = object(root.workspace);
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const patterns = strings(workspace.members).map(globSegments).filter(p => p !== null);
  const excludes = strings(workspace.exclude).map(e => e.replace(/^\.\//, '').replace(/\/+$/, '')).filter(safe);
  const members: string[] = [];
  for (const [folder, value] of manifests) {
    if (folder === lockDir) continue;
    const rel = below(lockDir, folder);
    if (rel === null) continue;
    const segments = rel.split('/');
    if (!patterns.some(p => globMatch(p, segments))) continue;
    if (excludes.some(e => rel === e || rel.startsWith(`${e}/`))) continue;
    // A member is a package; a folder with its own [workspace] or pointing package.workspace elsewhere belongs to another workspace.
    const manifest = parse(value);
    if (!manifest || !('package' in manifest) || 'workspace' in manifest) continue;
    const pointer = object(manifest.package).workspace;
    if (pointer !== undefined && (typeof pointer !== 'string' || resolvePath(folder, pointer) !== lockDir)) continue;
    members.push(folder);
  }
  return members.sort();
}

/** The package's name and version, with version.workspace = true taken from [workspace.package]. Cargo uses 0.0.0 when version is absent. */
function identity(manifest: Record<string, any>, root: Record<string, any> | null) {
  const pkg = object(manifest.package);
  const name = text(pkg.name);
  let version: unknown = pkg.version;
  if (version === undefined) version = '0.0.0';
  else if (object(version).workspace === true) version = object(object(root?.workspace).package).version;
  return name && localName.test(name) && typeof version === 'string' && semver.test(version) ? { name, version } : null;
}

const sections = [['dependencies', 'prod'], ['dev-dependencies', 'dev'], ['dev_dependencies', 'dev'], ['build-dependencies', 'build'], ['build_dependencies', 'build']] as const;
const stripCredentials = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1').replace(/[?#].*$/, '');

/** What a dependency entry asks for, following workspace = true into [workspace.dependencies]. null when it cannot be resolved. */
function declaration(key: string, raw: unknown, base: string, workspaceDeps: Record<string, any> | null, rootDir: string, scope: DependencyScope): Declaration | null {
  if (typeof raw === 'string') return { name: key, req: raw, kind: 'crates-io', git: null, path: null, scope, requested: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, any>;
  if (entry.workspace === true) {
    if (!workspaceDeps || !(key in workspaceDeps)) return null;
    // The member may only add features and optional; the rest comes from the workspace, with paths relative to the root.
    const inherited = declaration(key, workspaceDeps[key], rootDir, null, rootDir, scope);
    return inherited && { ...inherited, scope: entry.optional === true && scope === 'prod' ? 'optional' : scope };
  }
  const name = entry.package === undefined ? key : text(entry.package);
  if (!name || !localName.test(name)) return null;
  const req = text(entry.version);
  if (entry.version !== undefined && req === null) return null;
  const git = text(entry.git); const path = text(entry.path);
  const kind: Kind = path !== null ? 'path' : git !== null ? 'git' : entry.registry !== undefined || entry['registry-index'] !== undefined ? 'registry'
    : entry.git !== undefined || entry.path !== undefined ? 'unknown' : 'crates-io';
  const resolved = path !== null ? resolvePath(base, path) : null;
  const requested = req ?? (git !== null ? `git: ${stripCredentials(git)}` : path !== null ? `path: ${path}` : null);
  return { name, req, kind, git, path: resolved, scope: entry.optional === true && scope === 'prod' ? 'optional' : scope, requested };
}

/** Every dependency a manifest declares, including [target.*] sections. Build and target scopes say nothing about the current host. */
function declarations(manifest: Record<string, any>, folder: string, root: Record<string, any> | null, rootDir: string) {
  const workspaceDeps = root && 'workspace' in root ? object(object(root.workspace).dependencies) : null;
  const found: Declaration[] = []; const unresolved: string[] = [];
  const read = (table: Record<string, any>, targeted: boolean) => {
    for (const [section, kind] of sections) {
      // build-dependencies run on the build host; target sections apply only to some targets. Neither is known to be production.
      const scope: DependencyScope = kind === 'dev' ? 'dev' : kind === 'build' || targeted ? 'unknown' : 'prod';
      for (const [key, raw] of Object.entries(object(table[section]))) {
        const d = declaration(key, raw, folder, workspaceDeps, rootDir, scope);
        if (d) found.push(d); else unresolved.push(key);
      }
    }
  };
  read(manifest, false);
  for (const target of Object.values(object(manifest.target))) read(object(target), true);
  return { found, unresolved };
}

// Cargo version requirements: comma-separated comparators, with ^ when no operator is written. null when it cannot be read.
function satisfies(req: string, version: string): boolean | null {
  const v = version.match(semver);
  if (!v) return null;
  const comparators = req.trim() === '' ? ['*'] : req.split(',').map(c => c.trim());
  const parsed = comparators.map(c => c.match(/^(=|>=|<=|>|<|~|\^)?\s*(\d+|\*|x|X)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/));
  if (parsed.some(m => !m)) return null;
  const num = (s: string | undefined) => s === undefined || /^[*xX]$/.test(s) ? null : Number(s);
  // A prerelease version only matches a comparator that names a prerelease of the same major.minor.patch.
  if (v[4] && !parsed.some(m => m![5] && num(m![2]) === Number(v[1]) && num(m![3]) === Number(v[2]) && num(m![4]) === Number(v[3]))) return false;
  const cmp = (a: string) => compareSemver(version, a);
  return parsed.every(m => {
    const [, op = '^', a, b, c, pre] = m!;
    const major = num(a), minor = major === null ? null : num(b), patch = minor === null ? null : num(c);
    const at = (x: number, y: number, z: number, p = pre) => `${x}.${y}.${z}${p ? `-${p}` : ''}`;
    if (major === null) return true;
    const exact = at(major, minor ?? 0, patch ?? 0);
    const range = (low: string, high: string) => cmp(low) >= 0 && cmp(high) < 0;
    const next = minor === null ? at(major + 1, 0, 0, '') : patch === null ? at(major, minor + 1, 0, '') : null;
    switch (op) {
      case '=': return next ? range(exact, next) : cmp(exact) === 0;
      case '>': return next ? cmp(next) >= 0 : cmp(exact) > 0;
      case '>=': return cmp(exact) >= 0;
      case '<': return cmp(exact) < 0;
      case '<=': return next ? cmp(next) < 0 : cmp(exact) <= 0;
      case '~': return range(exact, minor === null ? at(major + 1, 0, 0, '') : at(major, minor + 1, 0, ''));
      default:
        if (major > 0 || minor === null) return range(exact, at(major + 1, 0, 0, ''));
        if (minor > 0 || patch === null) return range(exact, at(0, minor + 1, 0, ''));
        return range(exact, at(0, 0, patch + 1, ''));
    }
  });
}

const gitBase = (url: string) => url.replace(/^git\+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
function kindMatches(d: Declaration, p: Package) {
  switch (d.kind) {
    case 'crates-io': return p.source !== null && cratesIo.has(p.source);
    case 'registry': return cargoSource(p.source) === 'other-registry';
    case 'git': return cargoSource(p.source) === 'git' && gitBase(p.source!) === gitBase(d.git!);
    case 'path': return p.source === null;
    default: return false;
  }
}
// Several declarations of one package in a manifest give it the widest scope: prod, then unknown (build or target), optional, dev.
const rank: DependencyScope[] = ['prod', 'unknown', 'optional', 'dev', 'peer'];
const wider = (a: DependencyScope, b: DependencyScope) => rank.indexOf(a) <= rank.indexOf(b) ? a : b;

/**
 * Parses one Cargo.lock. lockDir is its folder relative to the project. Lockfile versions 2, 3 and 4 are read.
 * members lists folders below lockDir that the root [workspace] provably covers; their packages are not reported as dependencies.
 * A dependency is direct only when the lockfile's own entry for a member points to exactly one package that the declaration matches.
 */
export function parseCargoLock(lockText: string, manifests: Manifests, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'Cargo.lock');
  let lock: Record<string, any>;
  try { lock = object(parseToml(lockText)); } catch { return result('invalid', 'TOMLとして読み取れません', null); }

  // Cargo writes version = 3 or 4. Version 2 has no marker and records checksums in each package; version 1 keeps them in [metadata].
  let lockfileVersion: number;
  if (lock.version === undefined) {
    const v1 = Object.keys(object(lock.metadata)).some(key => key.startsWith('checksum '));
    const checksums = Array.isArray(lock.package) && lock.package.some((p: unknown) => typeof object(p).checksum === 'string');
    if (v1) return result('unsupported', 'version 1 の Cargo.lock は未対応です', null);
    if (!checksums) return result('unsupported', 'version の記載がなく形式を判別できないため未対応です', null);
    lockfileVersion = 2;
  } else if (lock.version === 3 || lock.version === 4) lockfileVersion = lock.version;
  else return result('unsupported', `version ${typeof lock.version === 'number' || typeof lock.version === 'string' ? lock.version : '不明'} は未対応です`, null);

  if (!Array.isArray(lock.package)) return result('invalid', 'package がありません', lockfileVersion);
  const packages: Package[] = []; const malformed: string[] = []; const seen = new Set<string>();
  (lock.package as unknown[]).forEach((value, index) => {
    const entry = object(value);
    const name = entry.name, version = entry.version, source = entry.source ?? null, deps = entry.dependencies ?? [];
    const label = typeof name === 'string' && name ? name : `#${index + 1}`;
    const valid = typeof name === 'string' && typeof version === 'string' && semver.test(version) && (source === null || typeof source === 'string')
      && (source !== null && cratesIo.has(source) ? publicName : localName).test(name)
      && Array.isArray(deps) && deps.every(d => typeof d === 'string') && (entry.checksum === undefined || typeof entry.checksum === 'string');
    if (!valid) { malformed.push(label); return; }
    const key = [name, version, source ?? ''].join('\0');
    if (seen.has(key)) { malformed.push(`${label} ${version}（重複）`); return; }
    seen.add(key);
    packages.push({ name, version, source, dependencies: deps });
  });

  // "name", "name version" or "name version (source)": Cargo adds version and source only when the name alone is ambiguous.
  const resolveEntry = (spec: string) => {
    const m = spec.match(/^(\S+)(?: (\S+))?(?: \((\S+)\))?$/);
    if (!m) return null;
    const hits = packages.filter(p => p.name === m[1] && (m[2] === undefined || p.version === m[2]) && (m[3] === undefined || p.source === m[3]));
    return hits.length === 1 ? hits[0] : null;
  };

  const root = parse(manifests.get(lockDir));
  const members = root ? workspaceMembers(lockDir, root, manifests) : [];
  const own = new Map<Package, string>(); const problems: string[] = []; const stale: string[] = []; const ambiguous: string[] = []; const unresolved: string[] = [];
  const owners: { folder: string; manifest: Record<string, any>; row: Package }[] = [];
  for (const folder of [...(root && 'package' in root ? [lockDir] : []), ...members]) {
    const manifest = folder === lockDir ? root! : parse(manifests.get(folder))!;
    const id = identity(manifest, root);
    if (!id) { problems.push(`${folder || '.'} の Cargo.toml の name/version を確定できません`); continue; }
    const row = packages.find(p => p.source === null && p.name === id.name && p.version === id.version);
    if (!row) { stale.push(`${id.name} ${id.version}`); continue; }
    own.set(row, folder); owners.push({ folder, manifest, row });
  }

  // Direct dependencies of each member, through the member's own entry in the lockfile.
  const direct = new Map<Package, Map<string, { scope: DependencyScope; requested: string | null }>>();
  for (const { folder, manifest, row } of owners) {
    const resolved = row.dependencies.map(spec => ({ spec, pkg: resolveEntry(spec) }));
    for (const { spec, pkg } of resolved) if (!pkg) malformed.push(`${row.name} の依存 "${spec}"`);
    const targets = resolved.flatMap(r => r.pkg ? [r.pkg] : []);
    const { found, unresolved: missing } = declarations(manifest, folder, root, lockDir);
    unresolved.push(...missing.map(name => `${row.name}: ${name}`));
    for (const d of found) {
      const candidates = targets.filter(p => p.name === d.name);
      let match: Package | null = null;
      if (candidates.length === 1) {
        match = candidates[0];
        if (d.req !== null && satisfies(d.req, match.version) === false) stale.push(`${row.name}: ${d.name} ${d.req}`);
      } else if (candidates.length > 1) {
        const narrowed = candidates.filter(p => kindMatches(d, p)).filter(p => d.req === null || satisfies(d.req, p.version) === true);
        if (narrowed.length === 1) match = narrowed[0];
        else ambiguous.push(`${row.name}: ${d.name}${d.req ? ` ${d.req}` : ''}`);
      } else stale.push(`${row.name}: ${d.name}`);
      if (!match || own.has(match)) continue; // A path dependency on a member is part of the workspace, not a dependency.
      const byFolder = direct.get(match) ?? new Map(); direct.set(match, byFolder);
      const previous = byFolder.get(folder);
      byFolder.set(folder, previous ? { scope: wider(previous.scope, d.scope), requested: previous.requested ?? d.requested } : { scope: d.scope, requested: d.requested });
    }
  }

  const dependencies: Dependency[] = [];
  for (const p of packages) {
    if (own.has(p)) continue;
    const base = { ecosystem: 'crates.io' as const, name: p.name, version: p.version, source: cargoSource(p.source), file };
    const declared = direct.get(p);
    if (declared) for (const [folder, d] of declared) dependencies.push({ ...base, requested: d.requested, direct: true, scope: d.scope, component: folder });
    else dependencies.push({ ...base, requested: null, direct: false, scope: 'unknown', component: lockDir });
  }

  const messages: string[] = [];
  if (malformed.length) messages.push(`読み取れない行が${malformed.length}件あり、一覧から外しています（${list(malformed)}）`);
  if (!root) messages.push(manifests.has(lockDir) ? 'Cargo.toml を読み取れないため、宣言との対応とワークスペースの範囲は未確認です' : '同じ場所に Cargo.toml がないため、宣言との対応とワークスペースの範囲は未確認です');
  messages.push(...problems);
  if (stale.length) messages.push(`Cargo.toml の宣言と lock が一致しません（${list(stale)}）。lock が古い可能性があります`);
  if (unresolved.length) messages.push(`解決できない宣言があります（${list(unresolved)}）`);
  if (ambiguous.length) messages.push(`同名で複数の版・取得元があり直接依存を特定できない宣言があります（${list(ambiguous)}）。間接として扱っています`);
  messages.push(note);
  const status = malformed.length ? 'invalid' : !root || problems.length || stale.length || unresolved.length ? 'mismatch' : 'ok';
  return result(status, messages.join('。'), lockfileVersion, dependencies, members);
}
