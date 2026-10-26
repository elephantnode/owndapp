import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { object, text, type ParsedLock } from './npm-lock.js';
import type { Dependency, DependencyScope, DependencySource } from '../shared/types.js';

// Reads Python lockfiles (poetry.lock, uv.lock, Pipfile.lock) and requirements files as data.
// Nothing is installed, run, or evaluated: pyproject.toml and Pipfile are parsed as TOML, setup.py is never read.

/** PEP 503 name: lowercase, runs of - _ . become one -. Lockfiles and advisories may spell the same package differently. */
export const normalizePython = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/g, '-');
const pypi = /^https?:\/\/(pypi\.org|pypi\.python\.org|files\.pythonhosted\.org)(\/|$)/;

// "name[extra] >=1.0 ; marker" (PEP 508). url is set for "name @ https://...".
function requirement(line: string) {
  const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  const rest = m[2].split(';')[0].trim();
  return rest.startsWith('@') ? { name: normalizePython(m[1]), spec: '', url: rest.slice(1).trim() } : { name: normalizePython(m[1]), spec: rest, url: null };
}

/** What pyproject.toml declares: PEP 621, PEP 735 dependency groups, Poetry, and uv's dev-dependencies. */
export function pyprojectDeclared(value: string | undefined | null) {
  const result = new Map<string, { range: string; scope: DependencyScope }>();
  if (!value) return result;
  let data: Record<string, any>;
  try { data = object(parseToml(value)); } catch { return result; }
  const add = (name: string, range: string, scope: DependencyScope) => { const key = normalizePython(name); if (key && key !== 'python' && !result.has(key)) result.set(key, { range, scope }); };
  const addAll = (list: unknown, scope: DependencyScope) => { for (const item of Array.isArray(list) ? list : []) { if (typeof item !== 'string') continue; const r = requirement(item); if (r) add(r.name, r.spec || r.url || '', scope); } };
  const project = object(data.project);
  addAll(project.dependencies, 'prod');
  for (const list of Object.values(object(project['optional-dependencies']))) addAll(list, 'optional');
  for (const list of Object.values(object(data['dependency-groups']))) addAll(list, 'dev');
  const poetry = object(object(data.tool).poetry);
  const poetryAdd = (deps: unknown, scope: DependencyScope) => { for (const [name, spec] of Object.entries(object(deps))) add(name, typeof spec === 'string' ? spec : text(object(spec).version) || '', scope); };
  poetryAdd(poetry.dependencies, 'prod');
  poetryAdd(poetry['dev-dependencies'], 'dev');
  for (const [group, value] of Object.entries(object(poetry.group))) poetryAdd(object(value).dependencies, group === 'main' ? 'prod' : 'dev');
  addAll(object(object(data.tool).uv)['dev-dependencies'], 'dev');
  return result;
}
/** True when pyproject.toml describes a Python project, not only tool settings such as ruff or black. */
export function isPythonProject(value: string) {
  try { const data = object(parseToml(value)); return !!(data.project || object(data.tool).poetry); } catch { return false; }
}

function finish(format: string, dependencies: Dependency[], members: string[], declared: Map<string, unknown>, manifestName: string, manifestFound: boolean): ParsedLock {
  if (!manifestFound) return { status: 'mismatch', message: `同じ場所の ${manifestName} を読み取れないため、宣言との対応は未確認です`, lockfileVersion: null, format, dependencies, members };
  const names = new Set(dependencies.map(d => d.name));
  const missing = [...declared.keys()].filter(name => !names.has(name));
  if (missing.length) return { status: 'mismatch', message: `${manifestName} の宣言と lock が一致しません（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' ほか' : ''}）。lock が古い可能性があります`, lockfileVersion: null, format, dependencies, members };
  return { status: 'ok', message: '', lockfileVersion: null, format, dependencies, members };
}
const invalid = (format: string, message = 'TOMLとして読み取れません'): ParsedLock => ({ status: 'invalid', message, lockfileVersion: null, format, dependencies: [], members: [] });

function row(name: string, version: string | null, declared: Map<string, { range: string; scope: DependencyScope }>, scope: DependencyScope, source: DependencySource, file: string, component: string): Dependency {
  const direct = declared.get(name);
  return { ecosystem: 'PyPI', name, version, requested: direct?.range ?? null, direct: !!direct, scope: direct?.scope ?? scope, source, file, component };
}

export function parsePoetryLock(lockText: string, pyproject: string | null, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'poetry.lock');
  let lock: Record<string, any>;
  try { lock = object(parseToml(lockText)); } catch { return invalid('Poetry'); }
  const version = text(object(lock.metadata)['lock-version']);
  const format = version ? `Poetry ${version}` : 'Poetry';
  if (!Array.isArray(lock.package)) return invalid(format, 'package がありません');
  const declared = pyprojectDeclared(pyproject);
  const dependencies = (lock.package as unknown[]).map(value => {
    const entry = object(value); const source = object(entry.source);
    const origin: DependencySource = !source.type ? 'registry' : source.type === 'legacy' ? (pypi.test(text(source.url) || '') ? 'registry' : 'other-registry')
      : source.type === 'git' ? 'git' : source.type === 'url' ? 'url' : source.type === 'file' || source.type === 'directory' ? 'file' : 'unknown';
    // Poetry 1.x marks dev packages with category; 2.x lists groups.
    const groups = Array.isArray(entry.groups) ? entry.groups as string[] : null;
    const scope: DependencyScope = entry.category === 'dev' || (groups && !groups.includes('main')) ? 'dev' : entry.optional === true ? 'optional' : 'prod';
    return row(normalizePython(text(entry.name) || ''), text(entry.version), declared, scope, origin, file, lockDir);
  }).filter(d => d.name);
  return finish(format, dependencies, [], declared, 'pyproject.toml', pyproject !== null);
}

/** uv.lock. pyprojects maps folders relative to the project to pyproject.toml text, for the workspace members it lists. */
export function parseUvLock(lockText: string, pyprojects: Map<string, string>, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'uv.lock');
  let lock: Record<string, any>;
  try { lock = object(parseToml(lockText)); } catch { return invalid('uv'); }
  const format = Number.isInteger(lock.version) ? `uv v${lock.version}` : 'uv';
  if (!Array.isArray(lock.package)) return invalid(format, 'package がありません');
  const members: string[] = []; const rows: { name: string; version: string | null; source: DependencySource }[] = [];
  for (const value of lock.package as unknown[]) {
    const entry = object(value); const source = object(entry.source);
    // The project and its workspace members are listed as editable or virtual packages, not as dependencies.
    const own = text(source.editable) ?? text(source.virtual);
    if (own !== null) { if (own !== '.') members.push(posix.join(lockDir, own)); continue; }
    const origin: DependencySource = source.registry ? (pypi.test(String(source.registry)) ? 'registry' : 'other-registry')
      : source.git ? 'git' : source.url ? 'url' : source.path || source.directory ? 'file' : 'unknown';
    rows.push({ name: normalizePython(text(entry.name) || ''), version: text(entry.version), source: origin });
  }
  const declared = new Map<string, { range: string; scope: DependencyScope }>();
  for (const folder of [lockDir, ...members]) for (const [name, d] of pyprojectDeclared(pyprojects.get(folder))) if (!declared.has(name)) declared.set(name, d);
  const dependencies = rows.filter(r => r.name).map(r => row(r.name, r.version, declared, 'unknown', r.source, file, lockDir));
  // Members depend on each other by name; they are not in the lock as packages.
  const memberNames = new Set([...pyprojects.values()].map(v => { try { return normalizePython(text(object(object(parseToml(v)).project).name) || ''); } catch { return ''; } }));
  for (const name of memberNames) declared.delete(name);
  return finish(format, dependencies, members, declared, 'pyproject.toml', pyprojects.has(lockDir));
}

export function parsePipfileLock(lockText: string, pipfile: string | null, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'Pipfile.lock');
  const format = 'Pipfile.lock';
  let lock: Record<string, any>;
  try { lock = object(JSON.parse(lockText)); } catch { return invalid(format, 'JSONとして読み取れません'); }
  if (!lock.default && !lock.develop) return invalid(format, 'default も develop もありません');
  const indexes = new Map<string, string>();
  for (const source of Array.isArray(object(lock._meta).sources) ? object(lock._meta).sources : []) { const s = object(source); if (text(s.name)) indexes.set(s.name, text(s.url) || ''); }
  const declared = new Map<string, { range: string; scope: DependencyScope }>();
  if (pipfile !== null) {
    try {
      const data = object(parseToml(pipfile));
      for (const [section, scope] of [['packages', 'prod'], ['dev-packages', 'dev']] as [string, DependencyScope][]) {
        for (const [name, spec] of Object.entries(object(data[section]))) {
          const key = normalizePython(name);
          if (!declared.has(key)) declared.set(key, { range: typeof spec === 'string' ? spec : text(object(spec).version) || '', scope });
        }
      }
    } catch { pipfile = null; }
  }
  const dependencies: Dependency[] = [];
  for (const [section, scope] of [['default', 'prod'], ['develop', 'dev']] as [string, DependencyScope][]) {
    for (const [name, value] of Object.entries(object(lock[section]))) {
      const entry = object(value);
      const pinned = text(entry.version)?.match(/^===?(.+)$/)?.[1] ?? null;
      const index = text(entry.index);
      const origin: DependencySource = entry.git ? 'git' : entry.path ? 'file' : entry.file ? 'url'
        : !pinned ? 'unknown' : index === null ? 'registry-unrecorded' : pypi.test(indexes.get(index) || '') ? 'registry' : 'other-registry';
      dependencies.push(row(normalizePython(name), pinned, declared, scope, origin, file, lockDir));
    }
  }
  return finish(format, dependencies, [], declared, 'Pipfile', pipfile !== null);
}

/**
 * requirements*.txt. Only exact pins (==1.2.3, ===1.2.3) give a version; other lines are kept with their specifier and no version,
 * so they are never sent. -r and -c includes are not followed: requirements files in the same folder are read on their own.
 */
export function parseRequirements(content: string, lockDir: string, fileName: string): ParsedLock {
  const file = posix.join(lockDir, fileName);
  const scope: DependencyScope = /dev|test|lint|doc|ci/i.test(fileName) ? 'dev' : 'prod';
  const lines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map(line => line.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
  // A non-PyPI index means pinned packages may come from there. With extra indexes, which one served a package is not recorded.
  const index = lines.map(l => l.match(/^(?:-i|--index-url)[\s=]+(\S+)/)?.[1]).find(Boolean);
  const extra = lines.some(l => /^--extra-index-url/.test(l));
  const registry: DependencySource = index && !pypi.test(index) && !extra ? 'other-registry' : 'registry-unrecorded';
  const dependencies: Dependency[] = []; let unpinned = 0;
  const fromUrl = (url: string, name?: string): Dependency | null => {
    const egg = url.match(/[#&]egg=([A-Za-z0-9._-]+)/)?.[1];
    const key = normalizePython(name || egg || url.replace(/[#?].*$/, '').replace(/\/$/, '').split('/').pop()?.replace(/(\.git|-[\d.]+.*\.(whl|tar\.gz|zip))$/, '') || '');
    if (!key) return null;
    const source: DependencySource = /^git\+|\.git(@|#|$)/.test(url) ? 'git' : /^(https?|ftp):/.test(url) ? 'url' : 'file';
    return { ecosystem: 'PyPI', name: key, version: null, requested: url, direct: true, scope, source, file, component: lockDir };
  };
  for (const raw of lines) {
    const line = raw.replace(/\s--hash[=\s]\S+/g, '').trim();
    const editable = line.match(/^(?:-e|--editable)[\s=]+(.+)$/);
    if (editable) { const d = fromUrl(editable[1].trim()); if (d) dependencies.push(d); continue; }
    if (line.startsWith('-')) continue; // -r, -c, --index-url and other options.
    if (/^(\.{0,2}\/|[a-z+]+:\/\/|git\+|file:)/i.test(line)) { const d = fromUrl(line); if (d) dependencies.push(d); continue; }
    const r = requirement(line);
    if (!r) continue;
    if (r.url) { const d = fromUrl(r.url, r.name); if (d) dependencies.push(d); continue; }
    const pin = r.spec.match(/^===?\s*([^\s,*]+)$/)?.[1] ?? null;
    if (!pin) unpinned++;
    dependencies.push({ ecosystem: 'PyPI', name: r.name, version: pin, requested: r.spec || null, direct: true, scope, source: registry, file, component: lockDir });
  }
  return unpinned
    ? { status: 'unpinned', message: `版を == で固定していない行が${unpinned}件あります。それらは照会しません`, lockfileVersion: null, format: 'requirements', dependencies, members: [] }
    : { status: 'ok', message: '', lockfileVersion: null, format: 'requirements', dependencies, members: [] };
}
