import { execFile, spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { absoluteFolder, pathWithin } from './paths.js';
import { pickerOutputLimit, pickerTimeout, windowsPowerShellPath, type WindowsPickerRunner } from './windows-folder-picker.js';

export type WindowsAppRole = 'editor' | 'terminal';

export const appPromptVariable = 'OWNDAPP_APP_PICKER_PROMPT';

// Fixed source: the prompt arrives only through the child's environment, never as source text.
// Uses .NET types directly so no cmdlet triggers module autoloading.
export const windowsAppPickerScript = [
  "$ErrorActionPreference = 'Stop'",
  "[void][System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')",
  "[void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
  '$owner = $null',
  '$dialog = $null',
  'try {',
  '  $owner = [System.Windows.Forms.Form]::new()',
  '  $owner.TopMost = $true',
  '  $owner.ShowInTaskbar = $false',
  '  $dialog = [System.Windows.Forms.OpenFileDialog]::new()',
  "  $dialog.Filter = 'アプリケーション (*.exe)|*.exe'",
  '  $dialog.Multiselect = $false',
  '  $dialog.CheckFileExists = $true',
  '  $dialog.CheckPathExists = $true',
  '  $dialog.DereferenceLinks = $true',
  '  $dialog.RestoreDirectory = $true',
  `  $dialog.Title = [System.Environment]::GetEnvironmentVariable('${appPromptVariable}')`,
  '  $chosen = $null',
  '  if (($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) -and $dialog.FileName) { $chosen = $dialog.FileName }',
  '  $result = [System.Collections.Generic.Dictionary[string,object]]::new()',
  "  $result['path'] = $chosen",
  '  $json = [System.Web.Script.Serialization.JavaScriptSerializer]::new().Serialize($result)',
  '  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)',
  '  $stdout = [System.Console]::OpenStandardOutput()',
  '  $stdout.Write($bytes, 0, $bytes.Length)',
  '  $stdout.Flush()',
  '} finally {',
  '  if ($null -ne $dialog) { $dialog.Dispose() }',
  '  if ($null -ne $owner) { $owner.Dispose() }',
  '}',
].join('\r\n');

const encodedScript = Buffer.from(windowsAppPickerScript, 'utf16le').toString('base64');
export const windowsAppPickerArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encodedScript];

const runExecFile: WindowsPickerRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'buffer' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

// An absolute drive or UNC path to a .exe, without NUL.
function absoluteExe(path: string) {
  return !path.includes('\0') && absoluteFolder(path, 'win32') && /\.exe$/i.test(path) && win32.basename(path).length > 4;
}

// Accepts exactly {"path": string|null} in UTF-8, with the string an absolute .exe path.
export function parseAppPickerOutput(stdout: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout).replace(/\r?\n$/, '');
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid picker response');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'path') throw new Error('invalid picker response');
  const path = (value as { path: unknown }).path;
  if (path === null) return null;
  if (typeof path !== 'string' || !absoluteExe(path)) throw new Error('invalid picker response');
  return path;
}

export function createWindowsAppPicker({ run = runExecFile, env = process.env, platform = process.platform }: {
  run?: WindowsPickerRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
} = {}) {
  return async (prompt: string): Promise<string | null> => {
    if (platform !== 'win32') throw new Error('unsupported');
    if (prompt.includes('\0')) throw new Error('invalid picker argument');
    const file = windowsPowerShellPath(env);
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== appPromptVariable));
    childEnv[appPromptVariable] = prompt;
    const stdout = await run(file, [...windowsAppPickerArgs], { env: childEnv, timeout: pickerTimeout, maxBuffer: pickerOutputLimit, windowsHide: true, shell: false });
    return parseAppPickerOutput(stdout);
  };
}

// Opens the Windows file dialog for an .exe on this PC. Resolves null when the user cancels.
export const chooseWindowsApplication: (prompt: string) => Promise<string | null> = createWindowsAppPicker();

// Editors receive the folder as their only argument. Anything else (node.exe, python.exe, ...) could run project code.
export const windowsEditors: readonly string[] = [
  'code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'sublime_text.exe',
  'idea64.exe', 'webstorm64.exe', 'pycharm64.exe', 'rider64.exe', 'zed.exe',
];
export const windowsTerminals: readonly string[] = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'wt.exe'];

const appName = (app: string) => win32.basename(app).toLowerCase();

export function windowsAppSupported(role: WindowsAppRole, path: string) {
  if (!absoluteExe(path)) return false;
  return (role === 'editor' ? windowsEditors : windowsTerminals).includes(appName(path));
}

// Fixed argument lists only: the folder is a single argv element or the cwd, never part of a command string.
export function windowsAppArgs(app: string, path: string, role: WindowsAppRole, env: NodeJS.ProcessEnv) {
  if (role === 'editor') return [path];
  switch (appName(app)) {
    case 'powershell.exe': case 'pwsh.exe': return ['-NoLogo', '-NoProfile', '-NoExit'];
    case 'cmd.exe':
      if (path.startsWith('\\\\')) throw new Error('unsupported UNC folder for cmd');
      return ['/D', '/K'];
    // Windows Terminal splits its arguments on ';' into subcommands, so such folders are refused.
    // An explicit powershell.exe keeps the user's default profile (which may be any command) out of it.
    case 'wt.exe':
      if (path.includes(';')) throw new Error('unsupported folder for Windows Terminal');
      return ['new-tab', '--startingDirectory', path, windowsPowerShellPath(env), '-NoLogo', '-NoProfile', '-NoExit'];
    default: throw new Error('unsupported application');
  }
}

export type WindowsSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  detached: true;
  stdio: 'ignore';
  windowsHide: false;
};
export type WindowsChild = {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
};
// Starts the file without a shell. Injected by tests in place of spawn.
export type WindowsSpawner = (file: string, args: string[], options: WindowsSpawnOptions) => WindowsChild;

// Variables that would turn an Electron editor into plain Node.js or preload code into it.
const strippedVariables = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

const runSpawn: WindowsSpawner = (file, args, options) => spawn(file, args, options);

export function createWindowsAppOpener({ start = runSpawn, env = process.env, platform = process.platform }: {
  start?: WindowsSpawner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
} = {}) {
  return (app: string, path: string, role: WindowsAppRole) => new Promise<void>((resolve, reject) => {
    if (platform !== 'win32') { reject(new Error('unsupported')); return; }
    if (!windowsAppSupported(role, app)) { reject(new Error('unsupported application')); return; }
    if (path.includes('\0') || !absoluteFolder(path, 'win32')) { reject(new Error('invalid folder')); return; }
    // An editor or shell stored inside the project would be the project's own code.
    if (pathWithin(path, app, 'win32')) { reject(new Error('unsupported application')); return; }
    let args: string[];
    try { args = windowsAppArgs(app, path, role, env); } catch (error) { reject(error); return; }
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !strippedVariables.includes(key.toUpperCase())));
    let child: WindowsChild;
    try {
      child = start(app, args, { cwd: path, env: childEnv, shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) { reject(error); return; }
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', reject);
  });
}

// Opens the folder with a registered editor, or a registered terminal started in the folder.
// Callers pass only registered applications and paths of registered projects.
export const openWindowsApp: (app: string, path: string, role: WindowsAppRole) => Promise<void> = createWindowsAppOpener();
