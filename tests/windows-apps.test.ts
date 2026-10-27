import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  appPromptVariable, createWindowsAppOpener, createWindowsAppPicker, parseAppPickerOutput, windowsAppPickerArgs, windowsAppPickerScript,
  windowsAppArgs, windowsAppSupported, windowsEditors, windowsTerminals, type WindowsAppRole, type WindowsSpawnOptions,
} from '../server/windows-apps.js';
import { pickerOutputLimit, pickerTimeout, type WindowsPickerRunOptions } from '../server/windows-folder-picker.js';

const systemEnv = { SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32` };
const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const project = String.raw`C:\Users\名前\Projects\app`;
const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const decoded = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

type PickCall = { file: string; args: string[]; options: WindowsPickerRunOptions };
function picker(reply: (call: PickCall) => Buffer | Promise<Buffer>, env: NodeJS.ProcessEnv = systemEnv) {
  const calls: PickCall[] = [];
  const choose = createWindowsAppPicker({ platform: 'win32', env, run: async (file, args, options) => { const call = { file, args, options }; calls.push(call); return reply(call); } });
  return { choose, calls };
}

class FakeChild extends EventEmitter { unrefs = 0; unref() { this.unrefs++; } }
type SpawnCall = { file: string; args: string[]; options: WindowsSpawnOptions; child: FakeChild };
// outcome: 'spawn' emits spawn, an Error emits error, 'throw' makes spawn itself throw.
function opener(outcome: 'spawn' | Error | 'throw' = 'spawn', env: NodeJS.ProcessEnv = systemEnv) {
  const calls: SpawnCall[] = [];
  const open = createWindowsAppOpener({ platform: 'win32', env, start: (file, args, options) => {
    if (outcome === 'throw') throw new Error('spawn EINVAL');
    const child = new FakeChild();
    calls.push({ file, args, options, child });
    queueMicrotask(() => outcome === 'spawn' ? child.emit('spawn') : child.emit('error', outcome));
    return child;
  } });
  return { open, calls };
}

test('Windows PowerShell 5.1をSystemRootからシェルなし・非表示・上限付きで起動し、.exeのパスを返す', async () => {
  const exe = String.raw`C:\Users\名前\AppData\Local\Programs\Microsoft VS Code\Code.exe`;
  const { choose, calls } = picker(() => json({ path: exe }));
  assert.equal(await choose('エディタを選択'), exe);
  const [{ file, args, options }] = calls;
  assert.equal(file, powershell);
  assert.deepEqual(args, windowsAppPickerArgs);
  for (const flag of ['-NoProfile', '-Sta', '-EncodedCommand']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some(arg => /executionpolicy|bypass|^-file$|^-command$/i.test(arg)));
  assert.equal(decoded(args), windowsAppPickerScript);
  assert.deepEqual({ ...options, env: undefined }, { env: undefined, timeout: pickerTimeout, maxBuffer: pickerOutputLimit, windowsHide: true, shell: false });
  assert.equal(options.env[appPromptVariable], 'エディタを選択');
  assert.equal(options.env.PATH, systemEnv.PATH);
});

test('固定スクリプトは.exeを1つだけ選ばせ、ダイアログを必ず破棄し、設定を変更しない', () => {
  assert.match(windowsAppPickerScript, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(windowsAppPickerScript, /Filter = '[^'|]*\|\*\.exe'/);
  assert.match(windowsAppPickerScript, /Multiselect = \$false/);
  assert.match(windowsAppPickerScript, /CheckFileExists = \$true/);
  assert.match(windowsAppPickerScript, /\} finally \{\r\n {2}if \(\$null -ne \$dialog\) \{ \$dialog\.Dispose\(\) \}/);
  assert.match(windowsAppPickerScript, new RegExp(`GetEnvironmentVariable\\('${appPromptVariable}'\\)`));
  assert.doesNotMatch(windowsAppPickerScript, /ExecutionPolicy|Bypass|Set-ItemProperty|Import-Module|Add-Type|Invoke-Expression|Start-Process|\$PROFILE/i);
});

test('キャンセルはnull、親プロセスの同名環境変数は持ち込まない', async () => {
  const { choose, calls } = picker(() => Buffer.from('{"path":null}\r\n'), { ...systemEnv, owndapp_app_picker_prompt: 'stale' });
  assert.equal(await choose('新しい'), null);
  const keys = Object.keys(calls[0].options.env).filter(key => key.toUpperCase() === appPromptVariable);
  assert.deepEqual(keys, [appPromptVariable]);
  assert.equal(calls[0].options.env[appPromptVariable], '新しい');
});

test('プロンプトのコード風の文字はスクリプトへ入れず環境変数の値としてそのまま渡す', async () => {
  for (const value of ["'; exit 1; '", '"; Start-Process calc; "', '$(Remove-Item -Recurse C:\\)', '`$env:SystemRoot` %PATH% ^& | < > ; {}', '改行\r\nWrite-Output 1']) {
    const { choose, calls } = picker(() => json({ path: null }));
    assert.equal(await choose(value), null);
    assert.deepEqual(calls[0].args, windowsAppPickerArgs, value);
    assert.equal(decoded(calls[0].args), windowsAppPickerScript);
    assert.ok(!calls[0].args.some(arg => arg.includes(value)));
    assert.equal(calls[0].options.env[appPromptVariable], value);
  }
});

test('NULを含むプロンプト・Windows以外・不正なSystemRootでは起動しない', async () => {
  let calls = 0;
  const run = async () => { calls++; return json({ path: null }); };
  await assert.rejects(createWindowsAppPicker({ platform: 'win32', env: systemEnv, run })('a\0b'));
  await assert.rejects(createWindowsAppPicker({ platform: 'darwin', env: systemEnv, run })('x'), /unsupported/);
  for (const env of [{}, { SystemRoot: 'Windows' }, { SystemRoot: String.raw`\\nas\Windows` }]) {
    await assert.rejects(createWindowsAppPicker({ platform: 'win32', env, run })('x'), JSON.stringify(env));
  }
  assert.equal(calls, 0);
});

test('ドライブ・UNC上の.exeを受け取り、不正な応答は拒否する', async () => {
  for (const path of [String.raw`D:\Tools\zed.exe`, String.raw`\\nas\share\アプリ\Cursor.EXE`, String.raw`C:\Program Files\Sublime Text\sublime_text.exe`]) {
    assert.equal(parseAppPickerOutput(json({ path })), path);
  }
  const replies = [
    '', 'not json', 'null', '[]', '{}', '{"path":1}', '{"path":""}', '{"path":null,"extra":1}', '{"Path":null}',
    '{"path":"C:\\\\Tools"}', '{"path":"C:\\\\Tools\\\\run.cmd"}', '{"path":"C:\\\\Tools\\\\Code.lnk"}', '{"path":"C:\\\\.exe"}',
    '{"path":"Code.exe"}', '{"path":"C:Code.exe"}', '{"path":"\\\\\\\\?\\\\C:\\\\Code.exe"}', '{"path":"/usr/bin/code.exe"}',
    '{"path":"C:\\\\a\\u0000b.exe"}', '{"path":null}\n{"path":null}', '\uFEFF{"path":null}',
  ].map(text => Buffer.from(text, 'utf8'));
  replies.push(Buffer.from([0x7b, 0x22, 0x70, 0x61, 0x74, 0x68, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  for (const reply of replies) {
    const { choose } = picker(() => reply);
    await assert.rejects(choose('x'), reply.toString('hex'));
  }
});

test('起動失敗・タイムアウト・出力超過は拒否する', async () => {
  for (const error of [
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  ]) {
    const { choose } = picker(() => Promise.reject(error));
    await assert.rejects(choose('x'), error);
  }
});

test('対応アプリはファイル名の許可リストで大文字小文字を区別せず判定する', () => {
  const editors = ['Code.exe', 'Code - Insiders.exe', 'Cursor.exe', 'Windsurf.exe', 'sublime_text.exe', 'idea64.exe', 'webstorm64.exe', 'pycharm64.exe', 'rider64.exe', 'zed.exe'];
  assert.deepEqual([...windowsEditors], editors.map(name => name.toLowerCase()));
  for (const name of editors) {
    assert.ok(windowsAppSupported('editor', 'C:\\Apps\\' + name.toUpperCase()), name);
    assert.ok(!windowsAppSupported('terminal', 'C:\\Apps\\' + name), name);
  }
  for (const name of ['powershell.exe', 'PWSH.EXE', 'cmd.exe', 'wt.exe']) {
    assert.ok(windowsAppSupported('terminal', '\\\\nas\\tools\\' + name), name);
    assert.ok(!windowsAppSupported('editor', 'C:\\Apps\\' + name), name);
  }
  assert.equal(windowsTerminals.length, 4);
  for (const role of ['editor', 'terminal'] as WindowsAppRole[]) {
    for (const path of [
      String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\Python\python.exe`, String.raw`C:\Windows\System32\wscript.exe`,
      String.raw`C:\Apps\Code.cmd`, String.raw`C:\Apps\Code.exe.lnk`, String.raw`C:\Apps\notCode.exe`, 'Code.exe', 'C:Code.exe',
      String.raw`\\?\C:\Apps\Code.exe`, '/Applications/Code.exe', 'C:\\Apps\\Code.exe\0', '',
    ]) assert.ok(!windowsAppSupported(role, path), `${role} ${path}`);
  }
});

test('エディタはシェルなし・切り離し・表示ありでフォルダを1引数として起動し、spawn後にunrefする', async () => {
  const code = String.raw`C:\Users\名前\AppData\Local\Programs\Microsoft VS Code\Code.exe`;
  const { open, calls } = opener('spawn', { ...systemEnv, ELECTRON_RUN_AS_NODE: '1', node_options: '--require x' });
  await open(code, project, 'editor');
  const [{ file, args, options, child }] = calls;
  assert.equal(file, code);
  assert.deepEqual(args, [project]);
  assert.deepEqual({ ...options, env: undefined }, { cwd: project, env: undefined, shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  assert.deepEqual(options.env, systemEnv);
  assert.equal(child.unrefs, 1);
});

test('各ターミナルは固定引数でフォルダをcwdに起動し、コマンド文字列を渡さない', async () => {
  const cases: [string, string[]][] = [
    [String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, ['-NoLogo', '-NoProfile', '-NoExit']],
    [String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, ['-NoLogo', '-NoProfile', '-NoExit']],
    [String.raw`C:\Windows\System32\cmd.exe`, ['/D', '/K']],
    [String.raw`C:\Users\名前\AppData\Local\Microsoft\WindowsApps\wt.exe`, ['new-tab', '--startingDirectory', project, powershell, '-NoLogo', '-NoProfile', '-NoExit']],
  ];
  for (const [app, expected] of cases) {
    const { open, calls } = opener();
    await open(app, project, 'terminal');
    assert.equal(calls[0].file, app);
    assert.deepEqual(calls[0].args, expected, app);
    assert.equal(calls[0].options.cwd, project);
    assert.equal(calls[0].options.shell, false);
    assert.ok(!calls[0].args.some(arg => /^-(command|c|file|encodedcommand|executionpolicy)$|^\/c$/i.test(arg)), app);
  }
});

test('記号やコード風の文字を含むフォルダもcwdか単一の引数としてそのまま渡す', async () => {
  const folders = [
    String.raw`C:\Users\山田 太郎\My Apps (x86) & 'test' #1`,
    String.raw`C:\tmp\$(Remove-Item -Recurse C:\)`,
    String.raw`C:\tmp\" & calc & "`,
    String.raw`C:\tmp\%PATH% !x! ^& | < > {}`,
    String.raw`\\nas\share\アプリ 開発\--inspect`,
  ];
  const apps: [string, WindowsAppRole][] = [
    [String.raw`C:\Apps\Cursor.exe`, 'editor'], [powershell, 'terminal'], [String.raw`C:\Windows\System32\cmd.exe`, 'terminal'], [String.raw`C:\Apps\wt.exe`, 'terminal'],
  ];
  for (const folder of folders) for (const [app, role] of apps) {
    const { open, calls } = opener();
    if (app.endsWith('cmd.exe') && folder.startsWith('\\\\')) { await assert.rejects(open(app, folder, role)); assert.equal(calls.length, 0); continue; }
    await open(app, folder, role);
    assert.equal(calls[0].options.cwd, folder);
    assert.equal(calls[0].args.filter(arg => arg.includes(folder)).length, role === 'editor' || app.endsWith('wt.exe') ? 1 : 0, `${app} ${folder}`);
    assert.ok(calls[0].args.every(arg => arg === folder || !arg.includes('&')), `${app} ${folder}`);
  }
});

test('Windows Terminalは区切り文字;を含むフォルダを拒否し、他のターミナルは受け付ける', async () => {
  const folder = String.raw`C:\tmp\a; new-tab cmd`;
  const { open, calls } = opener();
  await assert.rejects(open(String.raw`C:\Apps\wt.exe`, folder, 'terminal'), /Windows Terminal/);
  assert.equal(calls.length, 0);
  await open(powershell, folder, 'terminal');
  assert.equal(calls[0].options.cwd, folder);
});

test('許可リスト外・役割違い・相対や不正なフォルダ・プロジェクト内のexeは起動しない', async () => {
  const { open, calls } = opener();
  const rejected: [string, string, WindowsAppRole][] = [
    [String.raw`C:\Program Files\nodejs\node.exe`, project, 'editor'],
    [String.raw`C:\Program Files\nodejs\node.exe`, project, 'terminal'],
    [String.raw`C:\Windows\System32\cmd.exe`, project, 'editor'],
    [String.raw`C:\Apps\Code.exe`, project, 'terminal'],
    [String.raw`C:\Apps\Code.cmd`, project, 'editor'],
    ['Code.exe', project, 'editor'],
    [String.raw`C:\Apps\Code.exe`, String.raw`relative\dir`, 'editor'],
    [String.raw`C:\Apps\Code.exe`, 'C:relative', 'editor'],
    [String.raw`C:\Apps\Code.exe`, String.raw`\\?\C:\x`, 'editor'],
    [String.raw`C:\Apps\Code.exe`, '/tmp/x', 'editor'],
    [String.raw`C:\Apps\Code.exe`, 'C:\\x\0y', 'editor'],
    [`${project}\\tools\\Code.exe`, project, 'editor'],
    [`${project.toUpperCase()}\\pwsh.exe`, project, 'terminal'],
  ];
  for (const [app, path, role] of rejected) await assert.rejects(open(app, path, role), `${role} ${app} ${path}`);
  assert.equal(calls.length, 0);
});

test('Windows以外・不正なSystemRoot(wt)では起動しない', async () => {
  let started = 0;
  const start = () => { started++; return new FakeChild(); };
  await assert.rejects(createWindowsAppOpener({ platform: 'darwin', env: systemEnv, start })(String.raw`C:\Apps\Code.exe`, project, 'editor'), /unsupported/);
  await assert.rejects(createWindowsAppOpener({ platform: 'win32', env: { SystemRoot: 'Windows' }, start })(String.raw`C:\Apps\wt.exe`, project, 'terminal'));
  assert.equal(started, 0);
});

test('spawnのerrorイベントや例外はrejectし、unrefしない', async () => {
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const failed = opener(error);
  await assert.rejects(failed.open(String.raw`C:\Apps\zed.exe`, project, 'editor'), error);
  assert.equal(failed.calls[0].child.unrefs, 0);
  await assert.rejects(opener('throw').open(String.raw`C:\Apps\zed.exe`, project, 'editor'), /EINVAL/);
});

 test('cmdではUNC共有を拒否し、PowerShellではフォルダをcwdとして扱える', () => {
  const folder = String.raw`\\nas\share\project`;
  assert.throws(() => windowsAppArgs(String.raw`C:\Windows\System32\cmd.exe`, folder, 'terminal', {}));
  assert.deepEqual(windowsAppArgs(String.raw`C:\Apps\pwsh.exe`, folder, 'terminal', {}), ['-NoLogo', '-NoProfile', '-NoExit']);
 });
