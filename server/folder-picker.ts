import { execFile } from 'node:child_process';

export type FolderPicker = (defaultPath?: string, prompt?: string) => Promise<string | null>;

// The script receives the prompt and default folder as arguments, never as interpolated source text.
const script = [
  'on run argv',
  'activate',
  'if (count of argv) > 1 then',
  'set chosen to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))',
  'else',
  'set chosen to choose folder with prompt (item 1 of argv)',
  'end if',
  'return POSIX path of chosen',
  'end run',
];

// Opens the macOS folder dialog on this Mac. Resolves null when the user cancels.
export const chooseFolder: FolderPicker = (defaultPath, prompt = '探索するフォルダを選択') => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') { reject(new Error('unsupported')); return; }
  const args = [...script.flatMap(line => ['-e', line]), prompt];
  if (defaultPath) args.push(defaultPath);
  execFile('/usr/bin/osascript', args, { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
    if (error) { if (/-128/.test(stderr)) resolve(null); else reject(error); return; }
    const path = stdout.trim().replace(/(.)\/$/, '$1');
    resolve(path || null);
  });
});

export type FolderOpener = (path: string) => Promise<void>;

// Same as Finder's "Show in Finder": opens the parent window with the folder selected.
// Callers pass only paths of registered projects.
export const openInFinder: FolderOpener = path => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') { reject(new Error('unsupported')); return; }
  execFile('/usr/bin/open', ['-R', '--', path], { timeout: 30_000 }, error => error ? reject(error) : resolve());
});

export type AppPicker = (prompt: string) => Promise<string | null>;
export type AppOpener = (app: string, path: string) => Promise<void>;

const appScript = [
  'on run argv',
  'activate',
  'set chosen to choose application with prompt (item 1 of argv) as alias',
  'return POSIX path of chosen',
  'end run',
];

// Opens the macOS application chooser. Resolves the .app bundle path, or null when the user cancels.
export const chooseApplication: AppPicker = prompt => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') { reject(new Error('unsupported')); return; }
  execFile('/usr/bin/osascript', [...appScript.flatMap(line => ['-e', line]), prompt], { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
    if (error) { if (/-128/.test(stderr)) resolve(null); else reject(error); return; }
    const path = stdout.trim().replace(/(.)\/$/, '$1');
    resolve(path || null);
  });
});

// Opens the folder with the given application, as dropping the folder on the app's icon would.
// Callers pass only registered .app bundles and paths of registered projects.
export const openWithApp: AppOpener = (app, path) => new Promise((resolve, reject) => {
  if (process.platform !== 'darwin') { reject(new Error('unsupported')); return; }
  execFile('/usr/bin/open', ['-a', app, '--', path], { timeout: 30_000 }, error => error ? reject(error) : resolve());
});
