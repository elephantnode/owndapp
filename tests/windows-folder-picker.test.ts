import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindowsFolderPicker, defaultPathVariable, parsePickerOutput, pickerOutputLimit, pickerTimeout, promptVariable,
  windowsPickerArgs, windowsPickerScript, type WindowsPickerRunOptions,
} from '../server/windows-folder-picker.js';

type Call = { file: string; args: string[]; options: WindowsPickerRunOptions };
const systemEnv = { SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32` };
const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
function picker(reply: (call: Call) => Buffer | Promise<Buffer>, env: NodeJS.ProcessEnv = systemEnv) {
  const calls: Call[] = [];
  const choose = createWindowsFolderPicker({ platform: 'win32', env, run: async (file, args, options) => { const call = { file, args, options }; calls.push(call); return reply(call); } });
  return { choose, calls };
}
const decoded = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('Windows PowerShell 5.1をSystemRootの絶対パスからシェルなし・非表示・上限付きで起動する', async () => {
  const { choose, calls } = picker(() => json({ path: String.raw`C:\Users\名前\Projects` }));
  assert.equal(await choose(String.raw`C:\Users\名前`, '探索するフォルダ'), String.raw`C:\Users\名前\Projects`);
  const [{ file, args, options }] = calls;
  assert.equal(file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(args, windowsPickerArgs);
  for (const flag of ['-NoProfile', '-Sta', '-EncodedCommand']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some(arg => /executionpolicy|bypass|^-file$|^-command$/i.test(arg)));
  assert.equal(decoded(args), windowsPickerScript);
  assert.deepEqual({ ...options, env: undefined }, { env: undefined, timeout: pickerTimeout, maxBuffer: pickerOutputLimit, windowsHide: true, shell: false });
  assert.equal(pickerTimeout, 10 * 60_000);
  assert.equal(options.env[promptVariable], '探索するフォルダ');
  assert.equal(options.env[defaultPathVariable], String.raw`C:\Users\名前`);
  assert.equal(options.env.PATH, systemEnv.PATH);
});

test('固定スクリプトは新規フォルダ作成を無効にし、ダイアログを必ず破棄し、設定を変更しない', () => {
  assert.match(windowsPickerScript, /System\.Windows\.Forms\.FolderBrowserDialog/);
  assert.match(windowsPickerScript, /ShowNewFolderButton = \$false/);
  assert.match(windowsPickerScript, /\} finally \{\r\n {2}if \(\$null -ne \$dialog\) \{ \$dialog\.Dispose\(\) \}/);
  assert.match(windowsPickerScript, new RegExp(`GetEnvironmentVariable\\('${promptVariable}'\\)`));
  assert.match(windowsPickerScript, new RegExp(`GetEnvironmentVariable\\('${defaultPathVariable}'\\)`));
  assert.doesNotMatch(windowsPickerScript, /ExecutionPolicy|Bypass|Set-ItemProperty|Import-Module|Add-Type|Invoke-Expression|\$PROFILE/i);
});

test('キャンセルはnull、既定フォルダ未指定なら環境変数を渡さない', async () => {
  const { choose, calls } = picker(() => Buffer.from('{"path":null}\r\n'));
  assert.equal(await choose(), null);
  assert.equal(calls[0].options.env[promptVariable], '探索するフォルダを選択');
  assert.equal(defaultPathVariable in calls[0].options.env, false);
});

test('親プロセスにある同名の環境変数は子プロセスへ持ち込まない', async () => {
  const { choose, calls } = picker(() => json({ path: null }), { ...systemEnv, owndapp_folder_picker_default: String.raw`C:\stale`, [promptVariable]: 'stale' });
  await choose(undefined, '新しい');
  const keys = Object.keys(calls[0].options.env).filter(key => key.toUpperCase().startsWith('OWNDAPP_FOLDER_PICKER'));
  assert.deepEqual(keys, [promptVariable]);
  assert.equal(calls[0].options.env[promptVariable], '新しい');
});

test('日本語・空白・記号・コード風の文字はスクリプトへ入れず環境変数の値としてそのまま渡す', async () => {
  const values = [
    String.raw`C:\Users\山田 太郎\My Apps (x86) & 'test' #1`,
    String.raw`C:\tmp\$(Remove-Item -Recurse C:\)`,
    "'; exit 1; '",
    '"; Start-Process calc; "',
    '`$env:SystemRoot` %PATH% !x! ^& | < > ; {}',
    '改行\r\nWrite-Output 1',
  ];
  for (const value of values) {
    const { choose, calls } = picker(() => json({ path: null }));
    assert.equal(await choose(value, value), null);
    const [{ args, options }] = calls;
    assert.deepEqual(args, windowsPickerArgs, value);
    assert.equal(decoded(args), windowsPickerScript);
    assert.ok(!args.some(arg => arg.includes(value)));
    assert.equal(options.env[promptVariable], value);
    assert.equal(options.env[defaultPathVariable], value);
  }
});

test('NULを含む引数は起動せずに拒否する', async () => {
  const { choose, calls } = picker(() => json({ path: null }));
  await assert.rejects(choose('C:\\a\0b'));
  await assert.rejects(choose(undefined, 'a\0b'));
  assert.equal(calls.length, 0);
});

test('ドライブ・ルート・UNC・日本語や記号を含む絶対パスを受け取る', async () => {
  for (const path of ['D:\\',String.raw`\\nas\share`, String.raw`\\nas\share\アプリ 開発\$(x)`, String.raw`C:\Users\名前\{a}[b]'c'`]) {
    const { choose } = picker(() => json({ path }));
    assert.equal(await choose(), path);
  }
  assert.equal(parsePickerOutput(Buffer.from('{"path":"C:\\\\\u540d\u524d"}')), 'C:\\名前');
});

test('不正な応答は拒否する', async () => {
  const replies = [
    '', 'not json', '{"path":"C:\\\\a"', 'null', '[]', '"C:\\\\a"', '{}', '{"path":1}', '{"path":true}', '{"path":{}}',
    '{"path":""}', '{"path":"relative\\\\dir"}', '{"path":"C:relative"}', '{"path":"\\\\\\\\?\\\\C:\\\\a"}', '{"path":"\\\\\\\\.\\\\pipe\\\\x"}',
    '{"path":"\\\\\\\\nas"}', '{"path":"/tmp/x"}', '{"path":"C:\\\\a\\u0000b"}', '{"path":null,"extra":1}', '{"Path":null}',
    '{"path":null}\n{"path":null}', '\uFEFF{"path":null}',
  ].map(text => Buffer.from(text, 'utf8'));
  replies.push(Buffer.from([0x7b, 0x22, 0x70, 0x61, 0x74, 0x68, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  for (const reply of replies) {
    const { choose } = picker(() => reply);
    await assert.rejects(choose(), reply.toString('hex'));
  }
});

test('起動失敗・タイムアウト・出力超過は拒否する', async () => {
  const errors = [
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    Object.assign(new Error('Command failed: exit 1'), { code: 1 }),
  ];
  for (const error of errors) {
    const { choose } = picker(() => Promise.reject(error));
    await assert.rejects(choose(), error);
  }
});

test('Windows以外や不正なSystemRootでは起動しない', async () => {
  let calls = 0;
  const run = async () => { calls++; return json({ path: null }); };
  await assert.rejects(createWindowsFolderPicker({ platform: 'darwin', env: systemEnv, run })(), /unsupported/);
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: String.raw`\\nas\Windows` }, { SystemRoot: String.raw`\Windows` }]) {
    await assert.rejects(createWindowsFolderPicker({ platform: 'win32', env, run })(), JSON.stringify(env));
  }
  assert.equal(calls, 0);
  const { choose, calls: lower } = picker(() => json({ path: null }), { systemroot: String.raw`E:\WINDOWS` });
  await choose();
  assert.equal(lower[0].file, String.raw`E:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`);
});
