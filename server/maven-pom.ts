import { posix } from 'node:path';
import type { ParsedLock } from './npm-lock.js';
import type { Dependency, DependencyScope } from '../shared/types.js';

// Reads pom.xml as data. Maven is never run, so nothing is downloaded and no plugin or profile is evaluated.
// A POM declares direct dependencies only. Transitive ones, BOMs imported from a repository, and parents outside
// the project are resolved by Maven over the network, which this reader does not do.

// Comments and CDATA removed, so commented-out dependencies are not read.
const clean = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]).trim();

/** Each <tag>...</tag> at any depth of the given XML, not nested in another one of the same tag. */
function elements(xml: string, tag: string) {
  const found: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${tag}\\s*>`, 'g');
  for (const m of xml.matchAll(pattern)) found.push(m[1]);
  return found;
}
// The first <tag> value; '' for an empty <tag/>, null when absent.
function child(xml: string, tag: string) {
  const value = elements(xml, tag)[0];
  if (value !== undefined) return decode(value);
  return new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(xml) ? '' : null;
}
// Sections whose dependencies belong to plugins, profiles, or reports rather than the project.
const withoutSections = (xml: string, tags: string[]) => tags.reduce((text, tag) => text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?(?<!/)>[\\s\\S]*?</${tag}\\s*>`, 'g'), ''), xml);

// <exclusions> name other artifacts, whose groupId and artifactId must not be read as the dependency's own.
const withoutExclusions = (dependency: string) => withoutSections(dependency, ['exclusions']);

interface Pom { groupId: string | null; artifactId: string | null; version: string | null; parent: { groupId: string | null; version: string | null; relativePath: string | null } | null;
  properties: Map<string, string>; managed: Map<string, string>; imports: number; dependencies: string[] }

function readPom(text: string): Pom {
  const xml = clean(text);
  const parentXml = elements(xml, 'parent')[0];
  // Child elements of <project> only: drop the parent, build, profiles, and reporting sections first.
  const own = withoutSections(xml, ['parent', 'build', 'profiles', 'reporting']);
  const management = elements(own, 'dependencyManagement')[0] ?? '';
  const body = withoutSections(own, ['dependencyManagement']);
  const properties = new Map<string, string>();
  for (const block of elements(own, 'properties').slice(0, 1)) for (const m of block.matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g)) properties.set(m[1], decode(m[2]));
  const managed = new Map<string, string>(); let imports = 0;
  for (const dependency of elements(management, 'dependency').map(withoutExclusions)) {
    if (child(dependency, 'scope') === 'import') { imports++; continue; }
    const key = `${child(dependency, 'groupId')}:${child(dependency, 'artifactId')}`; const version = child(dependency, 'version');
    if (version && !managed.has(key)) managed.set(key, version);
  }
  // The project's own coordinates sit outside the dependency sections.
  const coordinates = withoutSections(body, ['dependencies', 'properties', 'modules', 'repositories', 'pluginRepositories', 'distributionManagement', 'developers', 'contributors', 'licenses', 'scm', 'organization', 'issueManagement', 'ciManagement', 'mailingLists']);
  return {
    groupId: child(coordinates, 'groupId'), artifactId: child(coordinates, 'artifactId'), version: child(coordinates, 'version'),
    parent: parentXml === undefined ? null : { groupId: child(parentXml, 'groupId'), version: child(parentXml, 'version'), relativePath: child(parentXml, 'relativePath') },
    properties, managed, imports, dependencies: elements(elements(body, 'dependencies')[0] ?? '', 'dependency').map(withoutExclusions),
  };
}

/** Where the parent POM is expected inside the project (relative to it), or null when there is none or it points elsewhere. */
export function parentPomPath(text: string, pomDir: string) {
  const parent = readPom(text).parent;
  if (!parent) return null;
  // An empty <relativePath/> means "look the parent up in a repository", not on disk.
  const relative = parent.relativePath ?? '../pom.xml';
  if (!relative) return null;
  const target = posix.normalize(posix.join(pomDir, relative.endsWith('.xml') ? relative : posix.join(relative, 'pom.xml')));
  return target.startsWith('../') || target === '..' || posix.isAbsolute(target) ? null : target;
}

/**
 * Reads the direct dependencies of one pom.xml. parents holds the texts of its parent POMs found in the project,
 * nearest first: their properties and dependencyManagement versions are inherited.
 */
export function parsePom(text: string, lockDir: string, parents: string[] = []): ParsedLock {
  const file = posix.join(lockDir, 'pom.xml');
  const format = 'Maven (pom.xml)';
  if (!/<project[\s>]/.test(clean(text))) return { status: 'invalid', message: '<project> がありません', lockfileVersion: null, format, dependencies: [], members: [] };
  const pom = readPom(text); const chain = [pom, ...parents.map(readPom)];
  const properties = new Map<string, string>();
  // The nearest definition wins, as in Maven.
  for (const p of [...chain].reverse()) for (const [key, value] of p.properties) properties.set(key, value);
  const version = pom.version ?? pom.parent?.version ?? null; const groupId = pom.groupId ?? pom.parent?.groupId ?? null;
  for (const [key, value] of [['project.version', version], ['pom.version', version], ['version', version], ['project.groupId', groupId],
    ['project.artifactId', pom.artifactId], ['project.parent.version', pom.parent?.version], ['project.parent.groupId', pom.parent?.groupId]] as const) {
    if (value) properties.set(key, value);
  }
  const resolve = (value: string | null) => {
    let current = value;
    for (let depth = 0; current && /\$\{/.test(current) && depth < 10; depth++) current = current.replace(/\$\{([^}]+)\}/g, (whole, key) => properties.get(key) ?? whole);
    return current && !/\$\{/.test(current) ? current : null;
  };
  const managed = new Map<string, string>();
  for (const p of chain) for (const [key, value] of p.managed) if (!managed.has(key)) managed.set(key, value);
  const imports = chain.reduce((sum, p) => sum + p.imports, 0);

  const dependencies: Dependency[] = []; let unresolved = 0;
  for (const entry of pom.dependencies) {
    const g = resolve(child(entry, 'groupId')); const a = resolve(child(entry, 'artifactId'));
    if (!g || !a) { unresolved++; continue; }
    const name = `${g}:${a}`;
    const declaredVersion = child(entry, 'version');
    const raw = declaredVersion ?? managed.get(name) ?? null;
    let resolved = resolve(raw);
    // [1.0,2.0) and similar ranges are resolved by Maven against a repository.
    if (resolved && /[[\](),]/.test(resolved)) resolved = null;
    if (!resolved) unresolved++;
    const scopeName = child(entry, 'scope') ?? 'compile';
    const scope: DependencyScope = child(entry, 'optional') === 'true' ? 'optional' : scopeName === 'test' ? 'dev' : 'prod';
    // system-scoped jars come from a path on disk.
    dependencies.push({ ecosystem: 'Maven', name, version: resolved, requested: declaredVersion, direct: true, scope, source: scopeName === 'system' ? 'file' : 'registry-unrecorded', file, component: lockDir });
  }
  const notes = [
    ...(unresolved ? [`版を決められない依存が${unresolved}件あります（親POM・BOM・プロパティ・範囲指定）。それらは照会しません`] : []),
    ...(imports ? [`リポジトリから読み込むBOMが${imports}件あり、その版の指定は反映していません`] : []),
    ...(pom.parent && !parents.length ? ['親POMがプロジェクト内に見つからないため、親の版の指定は反映していません'] : []),
    'pom.xml は直接依存だけを記載します。推移的な依存は照会しません',
  ];
  return { status: unresolved ? 'unpinned' : 'direct-only', message: notes.join('。'), lockfileVersion: null, format, dependencies, members: [] };
}
