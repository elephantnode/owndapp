import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { readSafe } from './scanner.js';
import { parseNpmLock, sha256, type ParsedLock } from './npm-lock.js';
import { parsePnpmLock, parseYarnLock } from './js-locks.js';
import { parseCargoLock } from './cargo-locks.js';
import { parseComposerLock } from './composer-lock.js';
import { isPythonProject, parsePipfileLock, parsePoetryLock, parseRequirements, parseUvLock } from './python-locks.js';
import { parseGoMod } from './go-mod.js';
import { parseGemfileLock } from './gemfile-lock.js';
import { parentPomPath, parsePom } from './maven-pom.js';
import { readFileStatuses, type Dependency, type DependencyStatus, type LockFileResult, type Project } from '../shared/types.js';

// Reads the lockfiles of a project and its components: npm, Yarn, pnpm, Composer, Python (Poetry, uv, Pipenv, requirements),
// Rust (Cargo.lock), Go (go.mod), Ruby (Gemfile.lock), and Maven (pom.xml, direct dependencies only).
// Files are only read as data. Nothing in the project is installed, run, or evaluated, and no file is written.
const lockLimit = 32 * 1024 * 1024;
const manifestLimit = 2 * 1024 * 1024;
const manifestNames = new Set(['package.json', 'composer.json', 'pyproject.toml', 'Pipfile', 'Cargo.toml', 'Gemfile']);
const requirementsFile = /^requirements[^/]*\.txt$/i;

async function exists(path: string) { return lstat(path).then(() => true, () => false); }

export interface DependencyReadResult { status: DependencyStatus; files: LockFileResult[]; dependencies: Dependency[] }

type Family = 'node' | 'php' | 'python' | 'rust' | 'ruby';
const noLockMessages: Record<Family, string> = {
  rust: 'Cargo.lock がありません',
  ruby: 'Gemfile.lock がありません',
  node: 'Node.js の lock がありません（npm・Yarn・pnpm に対応）',
  php: 'composer.lock がありません',
  python: 'Python の lock がありません（poetry.lock・uv.lock・Pipfile.lock・requirements*.txt に対応）',
};

/** Reads every supported lockfile of the project. Locations covered as workspace members of an outer lockfile are not reported as missing. */
export async function readDependencies(project: Pick<Project, 'path' | 'components'>): Promise<DependencyReadResult> {
  const locations = [...new Set(['', ...project.components.map(c => c.path.split('\\').join('/'))])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const files: LockFileResult[] = [];
  const dependencies: Dependency[] = [];
  const covered: Record<Family, Set<string>> = { node: new Set(), php: new Set(), python: new Set(), rust: new Set(), ruby: new Set() };
  const below = (location: string) => locations.filter(other => other !== location && (!location || other.startsWith(`${location}/`)));
  // Reads a small file of the project, or null when it is missing or cannot be read safely.
  const readText = async (path: string, max = manifestLimit) => readSafe(project.path, join(project.path, path), max).catch(() => null);

  /** Reads one lockfile with its manifest, and records the result. manifest is hashed so a change is noticed later. */
  const read = async (location: string, lockName: string, manifestName: string | null, parse: (lockText: string, manifestText: string | null) => ParsedLock, format: string, additionalManifests: Map<string, string> = new Map()) => {
    const dir = join(project.path, location);
    const lockPath = posix.join(location, lockName);
    const hashes: Record<string, string> = {};
    const info = await lstat(join(dir, lockName));
    if (info.isFile() && info.size > lockLimit) {
      files.push({ path: lockPath, lockfileVersion: null, format, status: 'too-large', message: `${Math.ceil(lockLimit / 1024 / 1024)}MiB を超えるため読み取りません`, hashes }); return null;
    }
    let lockText: string;
    try { lockText = await readSafe(project.path, join(dir, lockName), lockLimit); }
    catch { files.push({ path: lockPath, lockfileVersion: null, format, status: 'unreadable', message: '読み取れません。権限、シンボリックリンク、範囲外への参照を確認してください', hashes }); return null; }
    hashes[lockPath] = sha256(lockText);
    let manifestText: string | null = null;
    if (manifestName && await exists(join(dir, manifestName))) {
      const manifestPath = posix.join(location, manifestName);
      manifestText = await readText(manifestPath) ?? '';
      if (manifestText) hashes[manifestPath] = sha256(manifestText);
    }
    for (const [path, text] of additionalManifests) hashes[path] = sha256(text);
    const parsed = parse(lockText, manifestText);
    files.push({ path: lockPath, lockfileVersion: parsed.lockfileVersion, format: parsed.format, status: parsed.status, message: parsed.message, hashes });
    dependencies.push(...parsed.dependencies);
    return parsed;
  };
  // package.json or pyproject.toml of the location and the locations below it, for workspace lockfiles.
  const manifestsFrom = async (location: string, name: string) => {
    const map = new Map<string, string>();
    for (const folder of [location, ...below(location)]) { const value = await readText(posix.join(folder, name)); if (value !== null) map.set(folder, value); }
    return map;
  };
  const noLock = (location: string, manifest: string, family: Family) =>
    files.push({ path: posix.join(location, manifest), lockfileVersion: null, status: 'no-lock', message: noLockMessages[family], hashes: {} });

  for (const location of locations) {
    const dir = join(project.path, location);
    const has = (name: string) => exists(join(dir, name));

    if (!covered.node.has(location)) {
      const found: ParsedLock[] = []; let attempted = false;
      const npmLock = await has('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : await has('package-lock.json') ? 'package-lock.json' : null;
      if (npmLock) { attempted = true; const p = await read(location, npmLock, 'package.json', (lock, manifest) => parseNpmLock(lock, manifest, location, npmLock), 'npm'); if (p) found.push(p); }
      // A project may hold more than one Node.js lockfile, for example while moving between package managers. All are read.
      for (const [lockName, parse, format] of [['yarn.lock', parseYarnLock, 'Yarn'], ['pnpm-lock.yaml', parsePnpmLock, 'pnpm']] as const) {
        if (!await has(lockName)) continue;
        attempted = true;
        const manifests = await manifestsFrom(location, 'package.json');
        const p = await read(location, lockName, 'package.json', lock => parse(lock, manifests, location), format);
        if (p) found.push(p);
      }
      found.flatMap(p => p.members).forEach(member => covered.node.add(member));
      if (!attempted && await has('package.json')) noLock(location, 'package.json', 'node');
    }

    if (await has('composer.lock')) await read(location, 'composer.lock', 'composer.json', (lock, manifest) => parseComposerLock(lock, manifest, location), 'Composer');
    else if (await has('composer.json')) noLock(location, 'composer.json', 'php');

    if (!covered.python.has(location)) {
      let any = false;
      if (await has('poetry.lock')) { any = true; await read(location, 'poetry.lock', 'pyproject.toml', (lock, manifest) => parsePoetryLock(lock, manifest, location), 'Poetry'); }
      if (await has('uv.lock')) {
        any = true;
        const pyprojects = await manifestsFrom(location, 'pyproject.toml');
        const p = await read(location, 'uv.lock', 'pyproject.toml', lock => parseUvLock(lock, pyprojects, location), 'uv');
        p?.members.forEach(member => covered.python.add(member));
      }
      if (await has('Pipfile.lock')) { any = true; await read(location, 'Pipfile.lock', 'Pipfile', (lock, manifest) => parsePipfileLock(lock, manifest, location), 'Pipfile.lock'); }
      const requirements = (await readdir(dir).catch(() => [] as string[])).filter(name => requirementsFile.test(name)).sort();
      for (const name of requirements) { any = true; await read(location, name, null, lock => parseRequirements(lock, location, name), 'requirements'); }
      if (!any) {
        const pyproject = await readText(posix.join(location, 'pyproject.toml'));
        if (pyproject !== null && isPythonProject(pyproject)) noLock(location, 'pyproject.toml', 'python');
        else if (await has('Pipfile')) noLock(location, 'Pipfile', 'python');
      }
    }

    if (!covered.rust.has(location)) {
      if (await has('Cargo.lock')) {
        const manifests = await manifestsFrom(location, 'Cargo.toml');
        const hashes = new Map([...manifests].map(([folder, text]) => [posix.join(folder, 'Cargo.toml'), text]));
        const parsed = await read(location, 'Cargo.lock', 'Cargo.toml', lock => parseCargoLock(lock, manifests, location), 'Cargo', hashes);
        parsed?.members.forEach(member => covered.rust.add(member));
      } else if (await has('Cargo.toml')) noLock(location, 'Cargo.toml', 'rust');
    }
    // go.mod is both the manifest and the record of selected versions.
    if (await has('go.mod')) await read(location, 'go.mod', null, lock => parseGoMod(lock, location), 'Go modules');

    if (await has('Gemfile.lock')) await read(location, 'Gemfile.lock', 'Gemfile', (lock, manifest) => parseGemfileLock(lock, manifest, location), 'Bundler');
    else if (await has('Gemfile')) noLock(location, 'Gemfile', 'ruby');

    if (await has('pom.xml')) {
      // Parent POMs inside the project lend their properties and managed versions. Each is hashed so a change is noticed.
      const parents = new Map<string, string>();
      let current = await readText(posix.join(location, 'pom.xml'), lockLimit);
      for (let pomDir = location; current !== null && parents.size < 5;) {
        const parentPath = parentPomPath(current, pomDir);
        if (!parentPath || parents.has(parentPath) || parentPath === posix.join(location, 'pom.xml')) break;
        current = await readText(parentPath, lockLimit);
        if (current !== null) { parents.set(parentPath, current); pomDir = posix.dirname(parentPath) === '.' ? '' : posix.dirname(parentPath); }
      }
      await read(location, 'pom.xml', null, lock => parsePom(lock, location, [...parents.values()]), 'Maven (pom.xml)', parents);
    }

    // Known formats outside the parser set remain visible; a successful npm lock must not hide them.
    const names = (await readdir(dir).catch(() => [] as string[])).sort();
    const unsupported = [
      { format: 'SwiftPM', names: names.filter(name => name === 'Package.swift' || name === 'Package.resolved') },
      // A workspace's modules are read from their own go.mod; replace directives in go.work are not applied.
      { format: 'Go workspace', names: names.filter(name => name === 'go.work') },
      { format: 'Gradle', names: names.filter(name => ['build.gradle', 'build.gradle.kts', 'gradle.lockfile'].includes(name)) },
      { format: 'NuGet', names: names.filter(name => ['packages.lock.json', 'packages.config'].includes(name) || name.endsWith('.csproj')) },
      { format: 'Bun / Deno', names: names.filter(name => ['bun.lock', 'bun.lockb', 'deno.lock'].includes(name)) },
    ];
    for (const family of unsupported) for (const name of family.names) files.push({ path: posix.join(location, name), format: family.format, lockfileVersion: null, status: 'unsupported', message: `${family.format} の依存解析は未対応です。このファイルの依存は検索・脆弱性照会の対象に含まれていません。`, hashes: {} });
  }
  // Locations with no lock are listed for the detail view, but do not mark the project as "partial".
  // partial is reserved for real read problems (unreadable, invalid, unsupported, too-large).
  return { status: dependencyStatusOf(files), files, dependencies };
}

/** Derives the project-level status from per-file results. Safe to re-run on older snapshots. */
export function dependencyStatusOf(files: LockFileResult[]): DependencyStatus {
  const readCount = files.filter(f => readFileStatuses.includes(f.status)).length;
  const failed = files.filter(f => !readFileStatuses.includes(f.status) && f.status !== 'no-lock').length;
  return readCount ? (failed ? 'partial' : 'complete') : failed ? 'failed' : 'no-lock';
}

/** True when any file read for the snapshot has changed or disappeared since. */
export async function filesChanged(projectPath: string, files: LockFileResult[]) {
  for (const file of files) {
    for (const [path, hash] of Object.entries(file.hashes)) {
      const max = manifestNames.has(posix.basename(path)) ? manifestLimit : lockLimit;
      const current = await readSafe(projectPath, join(projectPath, path), max).then(sha256, () => null);
      if (current !== hash) return true;
    }
  }
  return false;
}
