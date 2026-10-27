import { posix } from 'node:path';
import type { ParsedLock } from './npm-lock.js';
import type { Dependency, DependencySource } from '../shared/types.js';

// Reads Gemfile.lock as data. Bundler and Ruby are never run, and the Gemfile (Ruby code) is not evaluated,
// so groups such as :development and :test are not known and every gem keeps the scope "unknown".

const rubygems = /^https?:\/\/(rubygems\.org|gems\.rubygems\.org|index\.rubygems\.org)\/?$/;

// One source section: GEM (a gem server), GIT, PATH, or PLUGIN SOURCE.
function sourceOf(section: string, remotes: string[]): DependencySource {
  if (section === 'GIT') return 'git';
  if (section === 'PATH') return 'file';
  if (section !== 'GEM' || !remotes.length) return 'unknown';
  if (remotes.every(remote => rubygems.test(remote))) return 'registry';
  // Older lockfiles list several servers in one GEM section without saying which gem came from which.
  return remotes.length === 1 ? 'other-registry' : 'unknown';
}

export function parseGemfileLock(lockText: string, manifestText: string | null, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'Gemfile.lock');
  const format = 'Bundler';
  type Spec = { name: string; version: string; section: string; remotes: string[] };
  const specs: Spec[] = []; const declared = new Map<string, string | null>();
  let section = ''; let remotes: string[] = []; let inSpecs = false; let sections = 0;
  for (const raw of lockText.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\S/.test(raw)) {
      section = raw.trim(); remotes = []; inSpecs = false;
      if (['GEM', 'GIT', 'PATH', 'PLUGIN SOURCE', 'DEPENDENCIES'].includes(section)) sections++;
      continue;
    }
    if (section === 'DEPENDENCIES') {
      // "  rails (~> 7.1)", "  mygem!" (from a GIT or PATH source).
      const m = raw.match(/^ {2}([^\s!(]+)!?(?: \((.+)\))?$/);
      if (m) declared.set(m[1], m[2] ?? null);
      continue;
    }
    if (!['GEM', 'GIT', 'PATH', 'PLUGIN SOURCE'].includes(section)) continue;
    const remote = raw.match(/^ {2}remote: (.+)$/);
    if (remote) { remotes.push(remote[1].trim()); continue; }
    if (/^ {2}specs:$/.test(raw)) { inSpecs = true; continue; }
    // Gems are indented by four spaces; their own dependencies, by six.
    const spec = inSpecs && raw.match(/^ {4}([^\s(]+) \(([^)]+)\)$/);
    if (spec) {
      // nokogiri (1.16.0-arm64-darwin): the platform follows the version, which itself never contains "-".
      specs.push({ name: spec[1], version: spec[2].split('-')[0], section, remotes });
    }
  }
  if (!sections) return { status: 'invalid', message: 'GEM・GIT・PATH・DEPENDENCIES のいずれもありません', lockfileVersion: null, format, dependencies: [], members: [] };

  const dependencies: Dependency[] = []; const seen = new Set<string>();
  for (const { name, version, section: from, remotes: servers } of specs) {
    // The same gem may be listed once per platform.
    if (seen.has(`${name}@${version}`)) continue;
    seen.add(`${name}@${version}`);
    const requested = declared.get(name) ?? null;
    dependencies.push({ ecosystem: 'RubyGems', name, version, requested, direct: declared.has(name), scope: 'unknown', source: sourceOf(from, servers), file, component: lockDir });
  }
  if (manifestText === null) return { status: 'mismatch', message: '同じ場所に Gemfile がありません', lockfileVersion: null, format, dependencies, members: [] };
  const names = new Set(specs.map(s => s.name));
  const missing = [...declared.keys()].filter(name => !names.has(name));
  // Bundler leaves out gems for other platforms (for example tzinfo-data on Windows), so a missing name is only a hint.
  if (missing.length) return { status: 'mismatch', message: `DEPENDENCIES の一部が specs にありません（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' ほか' : ''}）。別のプラットフォーム向けの gem か、lock が古い可能性があります`, lockfileVersion: null, format, dependencies, members: [] };
  return { status: 'ok', message: '', lockfileVersion: null, format, dependencies, members: [] };
}
