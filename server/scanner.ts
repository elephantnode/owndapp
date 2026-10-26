import { folderInput, pathWithin } from './paths.js';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import type { Candidate, Component, Evidence, Scan } from '../shared/types.js';

export const excluded = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.build', '.next', '.nuxt', 'target', '.terraform', '.aws-sam', 'cdk.out',
  '.serverless', '.owndapp', '.cache', '.pnpm-store', '.dart_tool', '.gradle', 'Pods', '.pytest_cache', '.mypy_cache', 'out', 'Carthage']);
export const known = /^(package\.json|composer\.json|pyproject\.toml|Cargo\.toml|go\.mod|go\.work|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|deno\.jsonc?|Gemfile|pom\.xml|build\.gradle(\.kts)?|Package\.swift|Dockerfile[^/]*|compose\.ya?ml|docker-compose[^/]*\.ya?ml|template\.ya?ml|template\.json|samconfig\.toml|serverless\.(ya?ml|json|ts)|cdk\.json|Pulumi\.ya?ml|vercel\.json|netlify\.toml|wrangler\.(toml|jsonc?)|firebase\.json|pnpm-workspace\.yaml|style\.css|pubspec\.yaml|\.clasp\.json|appsscript\.json|gapps\.config\.json)$/;
export const lockNames = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Cargo\.lock|deno\.lock)$/;
// A boundary owns every detected folder below it, except nested Git repositories.
// A Git repository with nothing but .git at its root is a container of separate apps, not a boundary.
const boundaryTechnologies = new Set(['AWS SAM', 'AWS Lambda設定', 'AWS IaC', 'Flutter', 'Dart', 'WordPress', 'Google Apps Script', 'Docker']);

/** template_file / template from samconfig.toml (any environment section). Relative paths only. */
function samTemplatePath(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const walk = (obj: Record<string, unknown>): string | null => {
    for (const [key, value] of Object.entries(obj)) {
      if ((key === 'template_file' || key === 'template') && typeof value === 'string' && value.trim()) {
        const path = value.trim().replace(/^\.\//, '');
        if (!path.includes('..') && !isAbsolute(path) && !path.includes('\\')) return path;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const found = walk(value as Record<string, unknown>);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(data as Record<string, unknown>);
}
export type NodeInfo = { path: string; name: string; technologies: string[]; evidence: Evidence[]; members: string[]; fingerprint: string;
  git: boolean; boundary: boolean };
type Limits = { depth: number; entries: number; milliseconds: number };
// Folders the user excluded, as canonical absolute paths. Each one also excludes all of its subfolders.
type ScanOptions = Partial<Limits> & { exclusions?: string[] };

export function within(root: string, target: string) {
  return pathWithin(root, target);
}

export function excludedBy(exclusions: string[], path: string) {
  return exclusions.find(exclusion => within(exclusion, path));
}

// Claude Code keeps working copies of a repository under .claude/worktrees. They duplicate the project they belong to.
const worktrees = /(^|[\\/])\.claude[\\/]worktrees([\\/]|$)/;
const swiftBuild = /(^|[\\/])\.build([\\/]|$)/;
export const defaultExcluded = (path: string) => worktrees.test(path) || swiftBuild.test(path);
/** User exclusion or the matching built-in generated-folder name. */
export function isExcluded(exclusions: string[], path: string) {
  return excludedBy(exclusions, path) ?? (worktrees.test(path) ? '.claude/worktrees' : swiftBuild.test(path) ? '.build' : undefined);
}

export async function readSafe(root: string, file: string, max = 2 * 1024 * 1024) {
  const resolved = await realpath(file);
  if (!within(root, resolved)) throw new Error('探索範囲外への参照です');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('読み取り対象外のファイルです');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino) throw new Error('ファイルが変更されました');
    if (!info.isFile() || info.size > max) throw new Error('読み取り対象外またはサイズ上限超過です');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > max || !within(root, await realpath(file))) throw new Error('ファイルが変更されました');
    return text;
  } finally { await handle.close(); }
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }
function yaml(text: string) {
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true });
  if (doc.errors.length) throw new Error('YAMLの構文を読み取れません');
  return object(doc.toJS({ maxAliasCount: 20 }));
}

// wp-includes alone also counts, since backups sometimes copy only part of the core.
function wordpressCore(names: Set<string>) {
  return names.has('wp-includes');
}
// wp-content, or a copy of it under another name. Backups often keep only themes and plugins, or put themes
// next to plugins/; WordPress ships plugins/index.php ("Silence is golden") in every install.
export async function wordpressContent(path: string, names: Set<string>) {
  if (basename(path) === 'wp-content' || (names.has('themes') && names.has('plugins'))) return true;
  if (!names.has('plugins')) return false;
  return lstat(join(path, 'plugins', 'index.php')).then(info => info.isFile(), () => false);
}
// Folders whose subfolders are bundled third-party code: WordPress core, plugin/theme internals, uploads,
// and pip install targets such as Lambda layers. contentRoots holds the wp-content folders seen so far.
export function skippedChildren(path: string, names: Set<string>, content: boolean, contentRoots: Set<string>) {
  if (wordpressCore(names)) return new Set(['wp-includes', 'wp-admin']);
  if (content) return new Set(['uploads', 'cache', 'upgrade']);
  if (['plugins', 'themes', 'mu-plugins'].includes(basename(dirname(path))) && contentRoots.has(dirname(dirname(path)))) return new Set(names);
  const source = names.has('.git') || names.has('pyproject.toml') || names.has('setup.py');
  if (!source && [...names].some(name => name.endsWith('.dist-info'))) return new Set(names);
  return new Set<string>();
}

export async function inspect(root: string, path: string, names: Set<string>, scan: Scan, skipped: Set<string>, content: boolean): Promise<NodeInfo | null> {
  const technologies = new Set<string>();
  const evidence: Evidence[] = [];
  const hashes: string[] = [];
  const members: string[] = [];
  let name = basename(path);
  let eligible = names.has('.git');
  // One evidence row per file, so a manifest that implies several technologies is listed once.
  function note(file: string, detail: string) {
    const found = evidence.find(e => e.file === file);
    if (found) found.detail += ` / ${detail}`; else evidence.push({ file, detail });
  }
  if (eligible) note('.git', 'Git管理の候補。詳細で remote・ブランチを読めます（変更の診断は未実装）');
  function add(tech: string, file: string, detail: string) { eligible = true; technologies.add(tech); note(file, detail); }
  for (const file of [...names].sort()) {
    const manifest = known.test(file) || /\.(csproj|tf|tf\.json)$/.test(file);
    const isLock = lockNames.test(file);
    if (!manifest && !isLock) continue;
    try {
      // Binary lockfiles are presence-only. All locks remain unparsed in this first slice.
      if (isLock) {
        const details: Record<string, string> = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'Yarn', 'uv.lock': 'uv', 'poetry.lock': 'Poetry', 'Cargo.lock': 'Cargo', 'composer.lock': 'Composer' };
        note(file, `${details[file] || '依存関係'}のlockあり。版の解析は未実装`);
        continue;
      }
      const text = await readSafe(root, join(path, file));
      hashes.push(`${file}:${createHash('sha256').update(text).digest('hex')}`);
      if (file === 'package.json') {
        const data = object(JSON.parse(text));
        if (typeof data.name === 'string' && data.name.trim()) name = data.name.slice(0, 200);
        add('Node.js系', file, 'package.jsonの存在。実行ランタイムは未確認');
        const deps = { ...object(data.devDependencies), ...object(data.dependencies) };
        for (const [dependency, label] of Object.entries({ next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', react: 'React', svelte: 'Svelte', astro: 'Astro', '@angular/core': 'Angular' })) {
          if (dependency in deps) add(label, file, `${dependency}の依存宣言あり。解決済み版は未確認`);
        }
        members.push(...strings(Array.isArray(data.workspaces) ? data.workspaces : object(data.workspaces).packages));
      } else if (file === 'pnpm-workspace.yaml') {
        add('pnpm workspace', file, 'workspaceの定義'); members.push(...strings(yaml(text).packages));
      } else if (file === 'pubspec.yaml') {
        const data = yaml(text);
        if (typeof data.name === 'string' && data.name.trim()) name = data.name.slice(0, 200);
        add('Dart', file, 'pubspec.yamlの存在。解決済み版は未確認');
        if ('flutter' in object(data.dependencies)) add('Flutter', file, 'flutterの依存宣言あり');
      } else if (file === '.clasp.json' || file === 'appsscript.json' || file === 'gapps.config.json') {
        add('Google Apps Script', file, file === 'appsscript.json' ? 'Apps Scriptのマニフェスト' : 'デプロイツールの設定あり。スクリプトIDなどは保存しません');
      } else if (file === 'pyproject.toml' || file === 'Cargo.toml') {
        const data = object(parseToml(text));
        const meta = object(file === 'Cargo.toml' ? data.package : data.project);
        if (typeof meta.name === 'string') name = meta.name.slice(0, 200);
        add(file === 'Cargo.toml' ? 'Rust' : 'Python', file, '静的なmanifest');
        if (file === 'Cargo.toml') members.push(...strings(object(data.workspace).members));
      } else if (file === 'composer.json') {
        const data = object(JSON.parse(text));
        if (typeof data.name === 'string') name = data.name.slice(0, 200);
        add('PHP', file, 'Composerの依存宣言');
        const deps = { ...object(data.require), ...object(data['require-dev']) };
        if ('laravel/framework' in deps) add('Laravel', file, 'laravel/frameworkの依存宣言');
      } else if (file === 'go.mod' || file === 'go.work') {
        add('Go', file, 'Goの構成ファイル');
        const moduleName = text.match(/^module\s+([^\s]+)/m)?.[1];
        if (moduleName) name = moduleName.replace(/^"|"$/g, '').slice(0, 200);
        if (file === 'go.work') {
          const block = text.match(/\buse\s*\(([\s\S]*?)\)/)?.[1] || '';
          members.push(...block.split('\n').map(v => v.trim().replace(/\s*\/\/.*$/, '').replace(/^"|"$/g, '')).filter(Boolean));
          for (const match of text.matchAll(/^use\s+([^\s(]+)/gm)) members.push(match[1].replace(/^"|"$/g, ''));
        }
      } else if (/^(requirements|setup\.|Pipfile)/.test(file)) add('Python', file, 'Pythonの構成ファイル。コードは実行しません');
      else if (/^deno\./.test(file)) add('Deno', file, 'Denoの構成ファイル');
      else if (/^(Dockerfile|compose\.|docker-compose)/.test(file)) add('Docker', file, 'Docker設定あり。実行状況は未確認');
      else if (file === 'samconfig.toml') {
        add('AWS SAM', file, 'samconfig.tomlあり。デプロイ先の実在は未確認');
        let pointed: string | null = null;
        try { pointed = samTemplatePath(parseToml(text)); } catch { note(file, 'TOMLの解析に失敗。テンプレート参照は未確認'); }
        if (pointed) {
          note(file, `template: ${pointed}`);
          try {
            const templateText = await readSafe(root, join(path, pointed));
            hashes.push(`${pointed}:${createHash('sha256').update(templateText).digest('hex')}`);
            if (/AWS::(Serverless::Function|Lambda::Function)/.test(templateText)) add('AWS Lambda設定', pointed, 'samconfigが指すテンプレートにLambdaの型宣言あり。クラウド上の実在は未確認');
            else if (/AWS::Serverless-2016-10-31|Transform\s*:\s*['"]?AWS::Serverless/.test(templateText)) add('AWS SAM', pointed, 'samconfigが指すテンプレートにSAM Transformあり');
            else if (/AWSTemplateFormatVersion/.test(templateText)) add('AWS IaC', pointed, 'samconfigが指すAWSテンプレートの宣言');
            else note(pointed, 'samconfigのtemplateを読んだが、SAM/Lambdaの型宣言は見つかりませんでした');
          } catch { note(pointed, 'samconfigのtemplateを読み取れません。パスや権限を確認してください'); }
        }
      } else if (/^template\./.test(file)) {
        // SAM/CloudFormation tags may be unknown to the data parser. Only literal type declarations are recognized.
        if (/AWS::(Serverless::Function|Lambda::Function)/.test(text)) {
          add('AWS Lambda設定', file, 'Lambdaの型宣言あり。クラウド上の実在は未確認');
          if (/AWS::Serverless-2016-10-31|Transform\s*:\s*['"]?AWS::Serverless/.test(text)) add('AWS SAM', file, 'SAM Transformの宣言あり');
        } else if (/AWS::Serverless-2016-10-31|Transform\s*:\s*['"]?AWS::Serverless/.test(text)) add('AWS SAM', file, 'SAM Transformの宣言あり。関数の型は未確認');
        else if (/AWSTemplateFormatVersion/.test(text)) add('AWS IaC', file, 'AWSテンプレートの宣言');
      } else if (/^serverless\./.test(file)) add('Serverless設定', file, '配置設定あり。コード・変数は評価しません');
      else if (file === 'cdk.json') add('AWS CDK', file, 'CDK設定あり。synthは実行しません');
      else if (/\.tf(\.json)?$/.test(file)) add('Terraform', file, 'IaCファイルあり。stateは読みません');
      else if (/^Pulumi\./.test(file)) add('Pulumi', file, '配置設定あり');
      else if (file === 'style.css' && /Theme Name\s*:/i.test(text)) add('WordPressテーマ', file, 'テーマの静的ヘッダー');
      else if (file === 'vercel.json') add('Vercel設定', file, '配置設定あり');
      else if (file === 'netlify.toml') add('Netlify設定', file, '配置設定あり');
      else if (/^wrangler\./.test(file)) add('Cloudflare設定', file, '配置設定あり');
      else if (file === 'firebase.json') add('Firebase設定', file, 'サービス設定あり');
      else if (file === 'Gemfile') add('Ruby', file, 'Gemfileあり。コードは評価しません');
      else if (file === 'pom.xml' || /^build\.gradle/.test(file)) add('Java/JVM', file, 'ビルド設定あり');
      else if (/\.csproj$/.test(file)) add('.NET', file, 'プロジェクトファイルあり');
      else if (file === 'Package.swift') add('Swift', file, 'Swift Packageの設定あり');
    } catch {
      eligible = true;
      scan.issues.push({ path: join(path, file), message: '設定の読取・解析に失敗しました。サイズ、権限、構文を確認してください' });
      note(file, '読み取りまたは解析に失敗。構成は未確認');
    }
  }
  if (wordpressCore(names)) add('WordPress', 'wp-includes', 'コア構造あり。設定の内容は読まず、wp-includes・wp-adminは探索しません');
  else if (names.has('wp-content')) add('WordPress', 'wp-content', 'wp-contentあり（WordPress本体なし）。バックアップやコンテンツの複製として1件にまとめます');
  else if (basename(path) !== 'wp-content' && content) add('WordPress', 'plugins', 'WordPressのpluginsあり。wp-contentの複製として1件にまとめます');
  if (!eligible) return null;
  if (skipped.size && [...names].some(name => name.endsWith('.dist-info'))) note('.', 'Pythonライブラリの同梱先のため、配下のフォルダは探索しません');
  const git = names.has('.git');
  return { path, name, technologies: [...technologies], evidence, members, fingerprint: createHash('sha256').update(hashes.join('\n')).digest('hex'),
    git, boundary: git || [...technologies].some(t => boundaryTechnologies.has(t)) };
}

export function memberMatch(pattern: string, path: string) {
  const p = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (/[{}[\]()]/.test(p) || p.includes('..') || isAbsolute(p)) return false;
  const expression = p.split('/').map(part => part === '**' ? '.*' : part.split('*').map(v => v.replace(/[.+?^$|\\]/g, '\\$&')).join('[^/]*')).join('/');
  return new RegExp(`^${expression}$`).test(path);
}

export function groupCandidates(nodes: NodeInfo[], registered: Set<string>): Candidate[] {
  const owned = new Set<string>();
  const candidates: Candidate[] = [];
  const gits = nodes.filter(node => node.git);
  const containers = new Set(gits.filter(git => git.evidence.length === 1 && nodes.some(child => child !== git && within(git.path, child.path))));
  for (const node of [...nodes].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))) {
    if (owned.has(node.path) || containers.has(node)) continue;
    const nestedGits = gits.filter(git => git !== node && within(node.path, git.path));
    const member = (child: NodeInfo) => {
      const path = relative(node.path, child.path).split(sep).join('/');
      return node.members.some(p => !p.startsWith('!') && memberMatch(p, path)) &&
        !node.members.some(p => p.startsWith('!') && memberMatch(p.slice(1), path));
    };
    const children = nodes.filter(child => child !== node && within(node.path, child.path) && !child.git &&
      !nestedGits.some(git => within(git.path, child.path)) && (node.boundary || member(child)));
    // Record the enclosing container repository, since the candidate itself has no .git.
    const repository = node.git ? undefined : gits.filter(git => git !== node && within(git.path, node.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const enclosing: Evidence[] = repository && containers.has(repository) ? [{ file: join(relative(node.path, repository.path), '.git'),
      detail: `Gitリポジトリ「${basename(repository.path)}」の中にあります。リポジトリ直下に設定ファイルがないため、中のアプリを個別の候補にしています` }] : [];
    const components: Component[] = children.map(child => ({ name: child.name, path: relative(node.path, child.path), technologies: child.technologies }));
    children.forEach(child => owned.add(child.path));
    const technologies = [...new Set([...node.technologies, ...children.flatMap(child => child.technologies)])];
    const evidence = [...node.evidence, ...enclosing, ...children.flatMap(child => child.evidence.map(e => ({ ...e, file: join(relative(node.path, child.path), e.file) })))];
    const fingerprint = createHash('sha256').update([node.fingerprint, ...children.map(c => c.fingerprint)].join('\n')).digest('hex');
    candidates.push({ id: createHash('sha256').update(node.path).digest('hex').slice(0, 24), path: node.path, name: node.name,
      technologies, components, evidence, fingerprint, registered: registered.has(node.path) });
  }
  return candidates;
}

export async function canonicalRoot(input: string) {
  const root = await realpath(folderInput(input));
  if (!(await stat(root)).isDirectory()) throw new Error('フォルダを指定してください');
  return root;
}

export function newScan(root: string): Scan {
  return { id: randomUUID(), root, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
    visited: 0, excluded: 0, candidates: [], issues: [], currentPath: root };
}

export async function runScan(scan: Scan, registered = new Set<string>(), signal?: AbortSignal,
  { exclusions = [], ...overrides }: ScanOptions = {}) {
  const limits = { depth: 12, entries: 1_000_000, milliseconds: 1_200_000, ...overrides };
  scan.limits = { entries: limits.entries, milliseconds: limits.milliseconds }; scan.found = 0; scan.pending = 1;
  const started = Date.now();
  const queue = [{ path: scan.root, depth: 0 }];
  const nodes: NodeInfo[] = [];
  const contentRoots = new Set<string>();
  // Folders left unread when the scan stops early. Candidates containing one are only partly known.
  let unread: string[] = [];
  // A scan rooted at a plugin or theme (an import re-reading one candidate) skips its internals as a scan of the whole site does.
  const grandparent = dirname(dirname(scan.root));
  if (['plugins', 'themes', 'mu-plugins'].includes(basename(dirname(scan.root)))) {
    const names = new Set(await readdir(grandparent).catch(() => [] as string[]));
    if (await wordpressContent(grandparent, names)) contentRoots.add(grandparent);
  }
  try {
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (signal?.aborted) { scan.status = 'cancelled'; break; }
      if (Date.now() - started >= limits.milliseconds || scan.visited >= limits.entries) {
        scan.issues.push({ path: scan.root, message: '探索の時間または件数の上限に達しました。範囲を分けて探索してください' });
        unread = queue.slice(cursor).map(item => item.path); break;
      }
      const item = queue[cursor]; scan.currentPath = item.path; scan.pending = queue.length - cursor;
      if (isExcluded(exclusions, item.path)) { scan.excluded++; continue; }
      try {
        if (!within(scan.root, await realpath(item.path))) throw new Error('out-of-root');
        const entries = await readdir(item.path, { withFileTypes: true });
        scan.visited += entries.length;
        const names = new Set(entries.filter(e => !e.isSymbolicLink()).map(e => e.name));
        const content = await wordpressContent(item.path, names);
        if (content) contentRoots.add(item.path);
        const skipped = skippedChildren(item.path, names, content, contentRoots);
        const node = await inspect(scan.root, item.path, names, scan, skipped, content);
        if (node) { nodes.push(node); scan.found = nodes.length; }
        // Depth counts from the nearest detected project, so deep collection folders keep room for project internals.
        const depth = node ? 0 : item.depth;
        for (const entry of entries) {
          if (signal?.aborted) break;
          if (entry.isSymbolicLink() || excluded.has(entry.name) || (skipped.has(entry.name) && entry.isDirectory()) ||
            (entry.isDirectory() && isExcluded(exclusions, join(item.path, entry.name)))) { scan.excluded++; continue; }
          if (entry.isDirectory()) {
            if (depth >= limits.depth) {
              scan.issues.push({ path: join(item.path, entry.name), message: '探索深さの上限により未探索です' });
            } else queue.push({ path: join(item.path, entry.name), depth: depth + 1 });
          }
        }
      } catch { scan.issues.push({ path: item.path, message: 'このフォルダを読み取れません。権限や存在を確認してください' }); }
      // Yield to HTTP requests so progress and cancellation remain responsive.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (signal?.aborted) scan.status = 'cancelled';
    if (scan.status === 'running') scan.status = scan.issues.length ? 'partial' : 'completed';
    scan.candidates = groupCandidates(nodes, registered);
    if (unread.length) for (const candidate of scan.candidates) if (unread.some(path => within(candidate.path, path))) candidate.incomplete = true;
  } catch { scan.status = 'failed'; scan.issues.push({ path: scan.root, message: '探索に失敗しました' }); }
  // Folders left unread stay counted, so a scan stopped at its limit says how much it did not read.
  scan.endedAt = new Date().toISOString(); scan.currentPath = ''; scan.pending = unread.length;
}

export async function revalidateCandidate(root: string, candidate: Candidate, exclusions: string[] = []) {
  if (!within(root, candidate.path)) throw new Error('探索範囲外です');
  if (await realpath(candidate.path) !== candidate.path) throw new Error('候補の場所が変わりました');
  // Re-scan only the selected project. This also refreshes grouped workspace components.
  const verification = newScan(candidate.path);
  await runScan(verification, undefined, undefined, { exclusions });
  const refreshed = verification.candidates.find(c => c.path === candidate.path);
  // A candidate the scan left partly unread cannot match its full read; the full read is what gets registered.
  if (!refreshed || (!candidate.incomplete && refreshed.fingerprint !== candidate.fingerprint) || verification.status === 'failed') {
    throw new Error('探索後に構成が変わったか、一部を確認できません。再探索してください');
  }
  return refreshed;
}
