import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { guardRegistry, type GuardApplyResult, type GuardState, type GuardStatus } from '../shared/guard.js';
import { CatalogError } from './store.js';

// Only the project root is inspected. Nothing here installs, runs project code or touches the network.

const npmrcLimit = 64 * 1024;
const configLimit = 1024 * 1024;
const lockLimit = 64 * 1024 * 1024;
const publicRegistries = new Set(['https://registry.npmjs.org/', 'https://registry.npmjs.org']);
const guardRegistries = new Set([guardRegistry, guardRegistry.slice(0, -1)]);
const guardHost = new URL(guardRegistry).host;
const foreignManagerFiles = ['yarn.lock', '.yarnrc.yml', '.yarnrc', '.pnp.cjs', 'bun.lock', 'bun.lockb', 'bunfig.toml'];
const npmLocks = ['package-lock.json', 'npm-shrinkwrap.json'];
// Keys that would send credentials or client certificates to whatever the default registry is.
const unscopedSecrets = new Set(['_auth', '_authtoken', '_password', 'password', 'username', 'cert', 'key', 'certfile', 'keyfile']);
// Keys that weaken transport checks or rewrite where lock entries are fetched from.
const unsafeKeys = new Set(['strict-ssl', 'ca', 'cafile', 'replace-registry-host', 'globalconfig', 'userconfig']);

type Entry =
  | { kind: 'missing' | 'symlink' | 'other' }
  | { kind: 'large'; info: Stats }
  | { kind: 'file'; info: Stats; bytes?: Buffer };

type Survey = { status: GuardStatus; dir?: Stats; npmrc?: Entry; next?: Buffer };

const fileKey = (info: Stats) => `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.uid}:${info.size}:${info.mtimeMs}`;

async function entry(dir: string, name: string, max: number, read: boolean): Promise<Entry> {
  const path = join(dir, name);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) return { kind: 'missing' };
  if (info.isSymbolicLink()) return { kind: 'symlink' };
  if (!info.isFile()) return { kind: 'other' };
  if (info.size > max) return { kind: 'large', info };
  if (!read) return { kind: 'file', info };
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ELOOP') return null;
    throw error;
  });
  if (!handle) return { kind: 'symlink' };
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('changed');
    const bytes = await handle.readFile();
    if (bytes.length > max) return { kind: 'large', info: opened };
    return { kind: 'file', info: opened, bytes };
  } finally { await handle.close(); }
}

function describe(name: string, item: Entry) {
  if (item.kind !== 'file') return `${name}\0${item.kind}${item.kind === 'large' ? `:${fileKey(item.info)}` : ''}`;
  const content = item.bytes ? createHash('sha256').update(item.bytes).digest('hex') : '-';
  return `${name}\0file:${fileKey(item.info)}:${content}`;
}

type NpmrcVerdict = { state: GuardState; message: string; next?: Buffer; warnings: string[] };

const blocked = (message: string): NpmrcVerdict => ({ state: 'blocked', message, warnings: [] });

export function planNpmrc(bytes: Buffer | null): NpmrcVerdict {
  if (bytes === null) return { state: 'available', message: '.npmrcを作成してGuardのregistryを設定できます', next: Buffer.from(`registry=${guardRegistry}\n`), warnings: [] };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return blocked('.npmrcがUTF-8として読めないため変更しません'); }
  if (text.includes('\0')) return blocked('.npmrcに想定外の文字があるため変更しません');

  const warnings: string[] = [];
  const lines = text.split('\n');
  let registryLine = -1;
  let registryValue = '';
  let scoped = false;
  let npmjsAuth = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '').replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) return blocked('.npmrcにセクション指定があるため、registryの扱いを確定できません');
    const at = line.indexOf('=');
    const rawKey = (at < 0 ? line : line.slice(0, at)).trim();
    const value = at < 0 ? '' : line.slice(at + 1).trim();
    if (/[$"'`\\]/.test(rawKey) || rawKey.endsWith('[]')) return blocked('.npmrcに環境変数や引用符を含む設定名があるため変更しません');
    const key = rawKey.toLowerCase();
    if (key.startsWith('//')) {
      const host = key.slice(2).split('/')[0].split(':')[0];
      if (host === guardHost) return blocked('Guard向けの認証設定があるため、Guardに資格情報が送られないよう変更しません');
      if (host === 'registry.npmjs.org') npmjsAuth = true;
      continue;
    }
    if (unscopedSecrets.has(key) || key === 'always-auth') return blocked('.npmrcにregistryを限定しない認証設定があるため、Guardへ資格情報が送られないよう変更しません');
    if (unsafeKeys.has(key)) return blocked('.npmrcに通信の検証や取得先を変える設定があるため変更しません');
    if (/^@[^:]+:registry$/.test(key)) { scoped = true; continue; }
    if (key === 'registry' || key.endsWith('registry')) {
      if (key !== 'registry' || rawKey !== 'registry') return blocked('.npmrcにregistryに似た設定名があるため変更しません');
      if (registryLine >= 0) return blocked('.npmrcにregistryが複数あるため変更しません');
      registryLine = index;
      registryValue = value;
    }
  }
  if (scoped) warnings.push('スコープ別のregistry指定はそのまま残します。それらのパッケージはGuardを経由しません');
  if (npmjsAuth) warnings.push('registry.npmjs.org向けの認証設定は残します。非公開パッケージはGuard経由で取得できない場合があります');

  if (registryLine >= 0 && guardRegistries.has(registryValue)) return { state: 'configured', message: '取得先はTakumi Guardです', warnings };
  if (registryLine >= 0 && !publicRegistries.has(registryValue))
    return { ...blocked('.npmrcに公開npm以外のregistry、または解釈できないregistry値があるため変更しません'), warnings };

  let next: string;
  if (registryLine < 0) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    next = text + (text.length && !text.endsWith('\n') ? eol : '') + `registry=${guardRegistry}${eol}`;
  } else {
    const original = lines[registryLine];
    const indent = original.match(/^﻿?[ \t]*/)![0];
    lines[registryLine] = `${indent}registry=${guardRegistry}${original.endsWith('\r') ? '\r' : ''}`;
    next = lines.join('\n');
  }
  const message = registryLine < 0 ? '.npmrcにGuardのregistryを追記できます' : '公開npmのregistryをGuardに置き換えられます';
  return { state: 'available', message, next: Buffer.from(next), warnings };
}

async function survey(path: string): Promise<Survey> {
  const warnings: string[] = [];
  const digest = createHash('sha256').update('owndapp-guard-1\0').update(path);
  const done = (state: GuardState, message: string, extra: Omit<Survey, 'status'> = {}): Survey =>
    ({ status: { state, message, revision: digest.digest('hex'), warnings: [...new Set(warnings)] }, ...extra });

  if (typeof path !== 'string' || !isAbsolute(path)) return done('blocked', 'プロジェクトの場所を確認できません');
  const dir = await lstat(path).catch(() => null);
  const resolved = await realpath(path).catch(() => null);
  if (!dir || !dir.isDirectory() || resolved !== path) return done('blocked', 'プロジェクトの場所が変わったか、読めません');
  digest.update(`\0dir:${dir.dev}:${dir.ino}`);

  const names = ['package.json', '.npmrc', 'pnpm-workspace.yaml', ...npmLocks, 'pnpm-lock.yaml', ...foreignManagerFiles];
  const items = new Map<string, Entry>();
  try {
    for (const name of names) {
      const limit = name === '.npmrc' ? npmrcLimit : name.includes('lock') ? lockLimit : configLimit;
      const read = name === 'package.json' || name === '.npmrc' || name === 'pnpm-workspace.yaml' || name === 'package-lock.json' || name === 'npm-shrinkwrap.json' || name === 'pnpm-lock.yaml';
      const item = await entry(path, name, limit, read);
      items.set(name, item);
      // Lock contents stay out of the revision; their identity and timestamp are enough to notice edits.
      digest.update(`\0${describe(name, name.includes('lock') && item.kind === 'file' ? { kind: 'file', info: item.info } : item)}`);
    }
  } catch { return done('blocked', 'プロジェクトの設定ファイルを読めませんでした'); }
  const get = (name: string) => items.get(name)!;

  warnings.push('プロジェクト直下の設定だけが対象です。サブフォルダの別プロジェクトや、環境変数・コマンド引数でのregistry指定は対象外です');

  const manifest = get('package.json');
  if (manifest.kind === 'missing') return done('unsupported', 'プロジェクト直下にpackage.jsonがないため、npmプロジェクトとして扱えません');
  if (manifest.kind !== 'file' || !manifest.bytes) return done('blocked', 'package.jsonが通常のファイルでないか、大きすぎます');
  let pkg: unknown;
  try { pkg = JSON.parse(manifest.bytes.toString('utf8')); } catch { return done('blocked', 'package.jsonをJSONとして読めません'); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return done('blocked', 'package.jsonの形式が想定と異なります');

  const declared = (pkg as Record<string, unknown>).packageManager;
  let manager: 'npm' | 'pnpm' | null = null;
  if (declared !== undefined) {
    if (typeof declared !== 'string') return done('blocked', 'package.jsonのpackageManagerを解釈できません');
    const name = declared.split('@')[0];
    if (name !== 'npm' && name !== 'pnpm')
      return done('unsupported', `${/^[a-z][a-z0-9-]{0,30}$/.test(name) ? name : '不明なパッケージマネージャー'}はGuard設定の対象外です（npmとpnpmのみ）`);
    manager = name;
  }
  const foreign = foreignManagerFiles.filter(name => get(name).kind !== 'missing');
  if (foreign.length) return done('unsupported', `YarnやBunの設定・ロック（${foreign.join('、')}）があるため、npmの設定だけでは保護を確認できません`);

  for (const name of [...npmLocks, 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    if (!['missing', 'file'].includes(get(name).kind)) return done('blocked', `${name}が通常のファイルでないか、大きすぎます`);
  const npmLock = npmLocks.some(name => get(name).kind === 'file');
  const pnpmLock = get('pnpm-lock.yaml').kind === 'file';
  if (manager === 'npm' && pnpmLock || manager === 'pnpm' && npmLock) return done('blocked', 'packageManagerとロックファイルの種類が一致しません');
  if (!manager && npmLock && pnpmLock) return done('blocked', 'npmとpnpmのロックファイルが両方あるため、使うパッケージマネージャーを確定できません');
  if (!manager) {
    manager = pnpmLock ? 'pnpm' : 'npm';
    warnings.push(`package.jsonにpackageManagerがないため、実際に使うパッケージマネージャーは確認できていません（${manager}として扱います）`);
  }

  const workspace = get('pnpm-workspace.yaml');
  if (workspace.kind === 'file' && workspace.bytes && /^\s*["']?(registry|registries|npmrc|@[^:\s]+:registry)["']?\s*:/m.test(workspace.bytes.toString('utf8')))
    return done('blocked', 'pnpm-workspace.yamlにregistryの設定があるため、.npmrcだけでは保護を確定できません');

  for (const name of [...npmLocks, 'pnpm-lock.yaml']) {
    const lock = get(name);
    if (lock.kind !== 'file' || !lock.bytes) continue;
    const text = lock.bytes.toString('utf8');
    const urls = name === 'pnpm-lock.yaml' ? text.match(/tarball:\s*['"]?[a-z+]+:[^\s'",}]+/gi) : text.match(/"resolved":\s*"[^"]+"/g);
    const foreignUrl = (urls ?? []).some(entry => !/https:\/\/(?:registry\.npmjs\.org|npm\.flatt\.tech)\//.test(entry));
    if (foreignUrl) warnings.push(`${name}に公開npm・Guard以外から取得する依存があります。それらはGuardを経由しません`);
  }
  if (manager === 'pnpm') warnings.push('pnpmのグローバル設定やpnpm-workspace.yaml以外の設定は確認していません');

  const npmrc = get('.npmrc');
  if (npmrc.kind === 'symlink') return done('blocked', '.npmrcがシンボリックリンクのため変更しません');
  if (npmrc.kind === 'other') return done('blocked', '.npmrcが通常のファイルではありません');
  if (npmrc.kind === 'large') return done('blocked', '.npmrcが64KBを超えているため変更しません');
  if (npmrc.kind === 'file') {
    if (npmrc.info.nlink !== 1) return done('blocked', '.npmrcがハードリンクされているため変更しません');
    if (typeof process.getuid === 'function' && npmrc.info.uid !== process.getuid()) return done('blocked', '.npmrcの所有者が現在のユーザーではないため変更しません');
  }
  const verdict = planNpmrc(npmrc.kind === 'file' ? npmrc.bytes! : null);
  warnings.push(...verdict.warnings);
  return done(verdict.state, verdict.message, { dir, npmrc, next: verdict.next });
}

export async function inspectGuard(path: string): Promise<GuardStatus> {
  return (await survey(path)).status;
}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink;

// Confirms the directory and .npmrc are still exactly what the plan was built from.
async function unchanged(path: string, plan: Survey) {
  const dir = await lstat(path).catch(() => null);
  if (!dir || !dir.isDirectory() || !plan.dir || dir.dev !== plan.dir.dev || dir.ino !== plan.dir.ino || await realpath(path).catch(() => null) !== path) return false;
  const current = await entry(path, '.npmrc', npmrcLimit, true).catch(() => null);
  if (!current || current.kind !== plan.npmrc!.kind) return false;
  if (current.kind !== 'file' || plan.npmrc!.kind !== 'file') return current.kind === 'missing';
  return sameFile(current.info, plan.npmrc!.info) && current.bytes!.equals(plan.npmrc!.bytes!);
}

async function createExclusive(file: string, bytes: Buffer, mode: number) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

const conflict = () => new CatalogError('プロジェクトの設定が確認後に変わりました。もう一度確認してから実行してください', 409);

export async function applyGuard(path: string, expectedRevision: string): Promise<GuardApplyResult> {
  const plan = await survey(path);
  if (typeof expectedRevision !== 'string' || plan.status.revision !== expectedRevision) throw conflict();
  if (plan.status.state === 'configured') return plan.status;
  if (plan.status.state !== 'available' || !plan.next || !plan.npmrc) throw new CatalogError(plan.status.message, 409);

  const unique = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const target = join(path, '.npmrc');
  const temporary = join(path, `.npmrc.owndapp-tmp-${unique}`);
  const original = plan.npmrc.kind === 'file' ? plan.npmrc : null;
  let backup: string | undefined;

  if (original) {
    backup = `.npmrc.owndapp-backup-${unique}`;
    await createExclusive(join(path, backup), original.bytes!, 0o600)
      .catch(() => { throw new CatalogError('.npmrcのバックアップを作成できませんでした。変更していません', 500); });
  }
  try {
    await createExclusive(temporary, plan.next, original ? original.info.mode & 0o777 : 0o600);
    // Check immediately before the swap. Node has no filesystem compare-and-swap; concurrent external edits can still race this rename.
    if (!(await unchanged(path, plan)) || (await survey(path)).status.revision !== expectedRevision) throw conflict();
    if (original) await rename(temporary, target);
    else await link(temporary, target).catch((error: NodeJS.ErrnoException) => { throw error.code === 'EEXIST' ? conflict() : error; });
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error instanceof CatalogError) throw error;
    throw new CatalogError('.npmrcを書き込めませんでした。変更していません', 500);
  }
  if (!original) await unlink(temporary).catch(() => {});

  const after = await survey(path);
  return backup ? { ...after.status, backup } : after.status;
}
