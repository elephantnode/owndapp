import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { absoluteFolder } from './paths.js';

export type WindowsPickerRunOptions = {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
};
// Runs the file without a shell and resolves its stdout. Injected by tests in place of execFile.
export type WindowsPickerRunner = (file: string, args: string[], options: WindowsPickerRunOptions) => Promise<Buffer>;

export const promptVariable = 'OWNDAPP_FOLDER_PICKER_PROMPT';
export const defaultPathVariable = 'OWNDAPP_FOLDER_PICKER_DEFAULT';
export const pickerTimeout = 10 * 60_000;
export const pickerOutputLimit = 64 * 1024;

// Fixed source: the prompt and default folder arrive only through the child's environment, never as source text.
// Uses .NET types directly so no cmdlet triggers module autoloading.
export const windowsPickerScript = [
  "$ErrorActionPreference = 'Stop'",
  "[void][System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')",
  "[void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
  '$owner = $null',
  '$dialog = $null',
  'try {',
  '  $owner = [System.Windows.Forms.Form]::new()',
  '  $owner.TopMost = $true',
  '  $owner.ShowInTaskbar = $false',
  '  $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()',
  '  $dialog.ShowNewFolderButton = $false',
  `  $dialog.Description = [System.Environment]::GetEnvironmentVariable('${promptVariable}')`,
  `  $initial = [System.Environment]::GetEnvironmentVariable('${defaultPathVariable}')`,
  '  if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }',
  '  $chosen = $null',
  '  if (($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) -and $dialog.SelectedPath) { $chosen = $dialog.SelectedPath }',
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

const encodedScript = Buffer.from(windowsPickerScript, 'utf16le').toString('base64');
export const windowsPickerArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encodedScript];

const runExecFile: WindowsPickerRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, encoding: 'buffer' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

function environmentValue(env: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// Windows PowerShell 5.1 lives under %SystemRoot%; refuses anything but a drive-rooted SystemRoot.
export function windowsPowerShellPath(env: NodeJS.ProcessEnv) {
  const root = environmentValue(env, 'SystemRoot');
  if (!root || !/^[a-z]:[\\/]/i.test(root) || root.includes('\0')) throw new Error('SystemRoot is not an absolute drive path');
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Accepts exactly {"path": string|null} in UTF-8, with the string an absolute drive or UNC path.
export function parsePickerOutput(stdout: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout).replace(/\r?\n$/, '');
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid picker response');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'path') throw new Error('invalid picker response');
  const path = (value as { path: unknown }).path;
  if (path === null) return null;
  if (typeof path !== 'string' || path.includes('\0') || !absoluteFolder(path, 'win32')) throw new Error('invalid picker response');
  return path;
}

export function createWindowsFolderPicker({ run = runExecFile, env = process.env, platform = process.platform }: {
  run?: WindowsPickerRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
} = {}) {
  return async (defaultPath?: string, prompt = '探索するフォルダを選択'): Promise<string | null> => {
    if (platform !== 'win32') throw new Error('unsupported');
    if (prompt.includes('\0') || defaultPath?.includes('\0')) throw new Error('invalid picker argument');
    const file = windowsPowerShellPath(env);
    const ours = [promptVariable, defaultPathVariable];
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !ours.includes(key.toUpperCase())));
    childEnv[promptVariable] = prompt;
    if (defaultPath) childEnv[defaultPathVariable] = defaultPath;
    const stdout = await run(file, [...windowsPickerArgs], { env: childEnv, timeout: pickerTimeout, maxBuffer: pickerOutputLimit, windowsHide: true, shell: false });
    return parsePickerOutput(stdout);
  };
}

// Opens the Windows folder dialog on this PC. Resolves null when the user cancels.
export const chooseWindowsFolder: (defaultPath?: string, prompt?: string) => Promise<string | null> = createWindowsFolderPicker();
