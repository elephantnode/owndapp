import { readFile, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const minimumNode = [24, 14, 0];
export function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^-]+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== minimumNode[i]) return parts[i] > minimumNode[i];
  return true;
}
// Native capabilities differ by OS.
export const supportedPlatforms = ['darwin', 'win32'];
export function platformMessage(platform) {
  if (platform === 'darwin') return 'macOS：フォルダ選択・外部アプリ起動に対応';
  if (platform === 'win32') return 'Windows：フォルダ選択・パス入力・対応する外部アプリ起動に対応';
  return `このOS（${platform}）はサポート対象外です。対応しているのはmacOSとWindowsです`;
}
const exists = async path => stat(path).then(info => info.isFile(), () => false);

// Only inspect files and environment values. Never import dependencies, open the
// database, contact a registry or OSV, install packages, or write any file.
export async function inspectRuntime({ root = fileURLToPath(new URL('..', import.meta.url)),
  nodeVersion = process.versions.node, platform = process.platform, env = process.env, development = false } = {}) {
  const checks = [];
  const add = (ok, message) => checks.push({ ok, message });
  add(supportedNode(nodeVersion), `Node.js ${nodeVersion}${supportedNode(nodeVersion) ? '' : '：24.14.0以降の正式版に切り替えてください'}`);
  add(supportedPlatforms.includes(platform), platformMessage(platform));
  const port = Number(env.OWNDAPP_PORT || 4310);
  add(Number.isInteger(port) && port >= 1024 && port <= 65535,
    Number.isInteger(port) && port >= 1024 && port <= 65535 ? `接続先：http://127.0.0.1:${port}（ポートの空き状況は起動時に確認）` : 'OWNDAPP_PORTは1024〜65535の整数を指定してください');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch { add(false, 'package.jsonを読めません。owndappのファイルがそろっているか確認してください'); }
  if (manifest) {
    const packages = [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.devDependencies || {})];
    const present = await Promise.all(packages.map(name => exists(join(root, 'node_modules', name, 'package.json'))));
    const missing = packages.filter((_, i) => !present[i]);
    const runner = await exists(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
    add(!missing.length && runner, missing.length || !runner
      ? `依存が未導入または不足しています${missing.length ? `（${missing.join('、')}）` : '（tsx）'}。docs/dependency-policy.mdを確認し、検査済みlockから npm ci --ignore-scripts --include=dev で準備してください。--omit=devは使わないでください`
      : '依存ファイル：存在を確認（脆弱性・署名・内容の検査は別途必要）');
  }
  if (!development) add(await exists(join(root, 'dist', 'index.html')),
    await exists(join(root, 'dist', 'index.html')) ? '表示用ファイル：ビルド済み（ソース更新後は npm run build を実行してください）' : '表示用ファイルがありません。依存の検査後に npm run build を実行してください');
  const dataDir = resolve(root, env.OWNDAPP_DATA_DIR || '.owndapp');
  const info = await stat(dataDir).catch(error => error.code === 'ENOENT' ? null : { error });
  add(!info || (!info.error && info.isDirectory()), !info ? `データ保存先：${dataDir}（初回起動時に作成。doctorは作成しません）`
    : info.error ? `データ保存先を確認できません：${dataDir}。アクセス権を確認してください`
    : info.isDirectory() ? `データ保存先：${dataDir}（既存の記録を使用）` : `データ保存先がフォルダではありません：${dataDir}。OWNDAPP_DATA_DIRを確認してください`);
  return checks;
}

export async function runDoctor(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('npm run doctor [-- --development]\n外部送信・自動修復・データ作成をせず起動環境を確認します。開発時は--developmentでビルド確認を省略します。');
    return 0;
  }
  if (args.some(arg => arg !== '--development')) { console.error('不明な指定です。npm run doctor -- --help を確認してください'); return 2; }
  const checks = await inspectRuntime({ development: args.includes('--development') });
  for (const check of checks) console.log(`${check.ok ? '[確認]' : '[要対応]'} ${check.message}`);
  if (checks.some(check => !check.ok)) { console.error('準備が整っていません。上の案内を確認してください。記録は変更していません。'); return 1; }
  console.log('起動の準備を確認しました。停止・更新・復元は docs/operations.md を参照してください。');
  return 0;
}
const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) process.exitCode = await runDoctor();
