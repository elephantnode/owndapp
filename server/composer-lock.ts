import { posix } from 'node:path';
import { object, text, type ParsedLock } from './npm-lock.js';
import type { Dependency, DependencyScope, DependencySource } from '../shared/types.js';

// Reads composer.lock as data, like npm-lock.ts. Nothing is installed or run, and composer.json is only parsed as JSON.
// php, ext-*, lib-* and composer-* are platform requirements, never packages in the lock.
const platform = /^(php(-64bit|-ipv6|-zts|-debug)?|hhvm|composer(-plugin|-runtime)?-api|composer|ext-.+|lib-.+)$/i;

// Packagist records where it was downloaded from as notification-url. Packages from VCS or path repositories have none.
function sourceOf(entry: Record<string, any>): DependencySource {
  const version = text(entry.version) || '';
  if (object(entry.dist).type === 'path') return 'file';
  // dev-main, 1.x-dev: a branch checkout, not a released version.
  if (/^dev-|-dev$/.test(version)) return 'git';
  const notify = text(entry['notification-url']);
  if (notify) return /^https?:\/\/(repo\.)?packagist\.org\//.test(notify) ? 'registry' : 'other-registry';
  if (['git', 'hg', 'svn'].includes(object(entry.source).type)) return 'git';
  if (text(object(entry.dist).url)) return 'url';
  return 'unknown';
}

export function parseComposerLock(lockText: string, manifestText: string | null, lockDir: string): ParsedLock {
  const file = posix.join(lockDir, 'composer.lock');
  const format = 'Composer';
  let lock: Record<string, any>;
  try { lock = object(JSON.parse(lockText)); } catch { return { status: 'invalid', message: 'JSONとして読み取れません', lockfileVersion: null, format, dependencies: [], members: [] }; }
  if (!Array.isArray(lock.packages)) return { status: 'invalid', message: 'packages がありません', lockfileVersion: null, format, dependencies: [], members: [] };
  let manifest: Record<string, any> | null = null;
  if (manifestText !== null) { try { manifest = object(JSON.parse(manifestText)); } catch { manifest = null; } }
  const declared = new Map<string, string>();
  for (const section of ['require', 'require-dev']) for (const [name, range] of Object.entries(object(manifest?.[section]))) {
    if (!platform.test(name) && typeof range === 'string') declared.set(name.toLowerCase(), range);
  }
  const dependencies: Dependency[] = []; const names = new Set<string>();
  for (const [section, scope] of [['packages', 'prod'], ['packages-dev', 'dev']] as [string, DependencyScope][]) {
    for (const value of Array.isArray(lock[section]) ? lock[section] : []) {
      const entry = object(value); const name = text(entry.name)?.toLowerCase();
      if (!name) continue;
      names.add(name);
      // v1.2.3 and 1.2.3 are the same release; advisories name versions without the v.
      const version = text(entry.version)?.replace(/^v(?=\d)/, '') ?? null;
      const requested = declared.get(name) ?? null;
      dependencies.push({ ecosystem: 'Packagist', name, version, requested, direct: requested !== null, scope, source: sourceOf(entry), file, component: lockDir });
    }
  }
  if (!manifest) return { status: 'mismatch', message: manifestText === null ? '同じ場所に composer.json がありません' : 'composer.json を読み取れないため、宣言との対応は未確認です', lockfileVersion: null, format, dependencies, members: [] };
  const missing = [...declared.keys()].filter(name => !names.has(name));
  if (missing.length) return { status: 'mismatch', message: `composer.json の宣言と lock が一致しません（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' ほか' : ''}）。lock が古い可能性があります`, lockfileVersion: null, format, dependencies, members: [] };
  return { status: 'ok', message: '', lockfileVersion: null, format, dependencies, members: [] };
}
