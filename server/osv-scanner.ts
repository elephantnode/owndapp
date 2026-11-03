import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { pathWithin } from './paths.js';
import type { OsvRecord } from './osv.js';

/**
 * osv-scanner (and docker, for images) as an optional helper. Nothing is installed: the tools are only used when found and enabled.
 * Never runs `fix`, `--serve`, call analysis (Rust's runs build scripts) or an image pull.
 */

/** Runs a file without a shell. Injected by tests in place of execFile. code is the exit status, or -1 when the file could not run or timed out. */
export type ScannerRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
const execRunner: ScannerRunner = (file, args, options) => new Promise(resolve => {
  execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
    // A non-zero exit puts the status in error.code; a missing file or a timeout leaves a string code or kills the process.
    const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
    const code = !failure ? 0 : typeof failure.code === 'number' && !failure.killed ? failure.code : -1;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

const outputLimit = 64 * 1024 * 1024;
const sourceTimeout = 2 * 60_000;
const imageTimeout = 10 * 60_000;

/** Lockfiles that owndapp does not parse but osv-scanner 2.x reads (checked against 2.7.0). */
export const scannerReadable = /^(Package\.resolved|pubspec\.lock|gradle\.lockfile|packages\.lock\.json|packages\.config|[^/\\]+\.csproj|bun\.lock|mix\.lock)$/;
// osv-scanner reads "-L name:path" as "parse as name", so a bare path breaks on a colon. These names are accepted that way (2.7.0);
// Package.resolved and .csproj are not, so they go as bare paths, and a path with a colon is refused.
const parseAs = new Set(['pubspec.lock', 'gradle.lockfile', 'packages.lock.json', 'packages.config', 'bun.lock', 'mix.lock']);

/** A docker image reference: no leading dash, so it can never be read as an option. */
export const imageReference = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

export class ScannerError extends Error {}

export interface ScannedPackage { ecosystem: string; name: string; version: string; records: OsvRecord[] }
export interface ScannerTools { osvScanner: { path: string; version: string } | null; docker: { path: string; running: boolean } | null }

async function locate(name: string, platform = process.platform) {
  const file = platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
  for (const dir of new Set(dirs)) {
    const path = join(dir, file);
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  return null;
}

/** Which tools are present. docker counts as running only when its daemon answers. */
export async function detectTools(runner: ScannerRunner = execRunner, find: (name: string) => Promise<string | null> = locate): Promise<ScannerTools> {
  const [scannerPath, dockerPath] = await Promise.all([find('osv-scanner'), find('docker')]);
  let osvScanner: ScannerTools['osvScanner'] = null;
  if (scannerPath) {
    const { code, stdout } = await runner(scannerPath, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const version = stdout.match(/osv-scanner version:\s*(\S+)/)?.[1];
    if (code === 0 && version) osvScanner = { path: scannerPath, version };
  }
  const docker = dockerPath ? { path: dockerPath, running: (await runner(dockerPath, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000, maxBuffer: 64 * 1024 })).code === 0 } : null;
  return { osvScanner, docker };
}

function packagesOf(stdout: string): ScannedPackage[] {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { throw new ScannerError('osv-scannerの出力を読み取れませんでした'); }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new ScannerError('osv-scannerの出力の形式が想定と違います');
  const packages: ScannedPackage[] = [];
  for (const result of results) for (const item of Array.isArray(result?.packages) ? result.packages : []) {
    const pkg = item?.package;
    if (typeof pkg?.ecosystem !== 'string' || typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string') continue;
    const records = (Array.isArray(item.vulnerabilities) ? item.vulnerabilities : []).filter((r: unknown): r is OsvRecord => typeof (r as OsvRecord)?.id === 'string');
    packages.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, records });
  }
  return packages;
}

// 0: nothing found, 1: vulnerabilities found, 128: no packages in the input. Anything else is a failure.
function scanned(result: { code: number; stdout: string; stderr: string }) {
  if (result.code === 128) return [];
  if (result.code === 0 || result.code === 1) return packagesOf(result.stdout);
  throw new ScannerError(result.stderr.trim().split('\n').pop()?.slice(0, 300) || 'osv-scannerを実行できませんでした');
}

const sourceArgs = (resolve: boolean) => ['scan', 'source', '--format', 'json', '--no-call-analysis=all', ...(resolve ? [] : ['--no-resolve'])];

/** Scans one lockfile inside the project folder. The file must resolve inside the folder, as every other read does. */
export async function scanLockfile(tool: string, projectPath: string, relativePath: string, { resolve = false, runner = execRunner } = {}) {
  const path = join(projectPath, relativePath);
  const resolved = await realpath(path).catch(() => null);
  if (!resolved || !pathWithin(await realpath(projectPath), resolved)) throw new ScannerError('フォルダの外を指すファイルは照会しません');
  const name = basename(resolved);
  if (!scannerReadable.test(name)) throw new ScannerError('osv-scannerで読めない形式です');
  if (!parseAs.has(name) && resolved.includes(':')) throw new ScannerError(`パスに「:」を含む ${name} は osv-scanner に渡せません`);
  const target = parseAs.has(name) ? `${name}:${resolved}` : resolved;
  return scanned(await runner(tool, [...sourceArgs(resolve), '-L', target], { timeout: sourceTimeout, maxBuffer: outputLimit }));
}

/**
 * Scans a local docker image. It is never pulled: a missing image is an error. The image is saved to a private temporary folder,
 * scanned as an archive and deleted, whatever happens.
 */
export async function scanImage(tools: { osvScanner: string; docker: string }, reference: string, { runner = execRunner, temp = tmpdir() } = {}) {
  if (!imageReference.test(reference)) throw new ScannerError('イメージ名の形式を確認してください');
  const inspected = await runner(tools.docker, ['image', 'inspect', '--format', '{{.Id}}', reference], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const imageId = inspected.stdout.trim();
  if (inspected.code !== 0 || !imageId) throw new ScannerError('手元にないイメージです（取得はしません）');
  const dir = await mkdtemp(join(temp, 'owndapp-image-'));
  try {
    const archive = join(dir, 'image.tar');
    const saved = await runner(tools.docker, ['image', 'save', '--output', archive, reference], { timeout: imageTimeout, maxBuffer: 1024 * 1024 });
    if (saved.code !== 0) throw new ScannerError('イメージを書き出せませんでした。空き容量とDockerの状態を確認してください');
    const packages = scanned(await runner(tools.osvScanner, ['scan', 'image', '--archive', '--format', 'json', '--no-call-analysis=all', '--no-resolve', archive], { timeout: imageTimeout, maxBuffer: outputLimit }));
    return { imageId, packages };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export interface DockerImage { reference: string; id: string; size: string; created: string }
/** Local images with a name. Untagged (<none>) images cannot be chosen, since a check names the image. */
export async function listImages(docker: string, runner: ScannerRunner = execRunner): Promise<DockerImage[]> {
  const { code, stdout } = await runner(docker, ['image', 'ls', '--format', '{{json .}}'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (code !== 0) throw new ScannerError('Dockerのイメージ一覧を読めませんでした。Dockerが起動しているか確認してください');
  const images: DockerImage[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, string>;
      if (!row.Repository || row.Repository === '<none>' || !row.Tag || row.Tag === '<none>') continue;
      const reference = `${row.Repository}:${row.Tag}`;
      if (imageReference.test(reference)) images.push({ reference, id: row.ID ?? '', size: row.Size ?? '', created: row.CreatedSince ?? '' });
    } catch { /* A line that is not JSON is skipped. */ }
  }
  return images;
}
