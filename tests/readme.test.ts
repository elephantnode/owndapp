import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRoot } from '../server/scanner.js';
import { purposeFromReadme, suggestPurpose } from '../server/readme.js';

test('READMEの見出し・バッジ・画像・HTML・コードを飛ばして、最初の説明の段落を使う', () => {
  assert.equal(purposeFromReadme([
    '---', 'title: x', '---',
    '<p align="center"><img src="logo.png"></p>',
    '# photo-notes',
    '[![build](https://img.shields.io/badge/x.svg)](https://ci) ![license](https://img.shields.io/y.svg)',
    '',
    '```sh', 'npm install', '```',
    '写真と日記を**ひとつの画面**で振り返る、[家族向け](https://example.com)の小さなアプリです。',
    'オフラインでも使えます。',
    '',
    '## 使い方',
  ].join('\n')), '写真と日記をひとつの画面で振り返る、家族向けの小さなアプリです。 オフラインでも使えます。');
  assert.equal(purposeFromReadme('# Tool\n\n- item one\n- item two\n\n> quote\n\n| a | b |\n|---|---|\n\nMonitors AWS Lambda costs and posts a daily summary to Slack.'),
    'Monitors AWS Lambda costs and posts a daily summary to Slack.');
});

test('生成ツールの定型文や、意味のない行は使わない', () => {
  assert.equal(purposeFromReadme('# my-app\n\nThis project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).\n\n## Available Scripts'), null);
  assert.equal(purposeFromReadme('# web\n\nThis is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://x).'), null);
  assert.equal(purposeFromReadme('# app\n\nA new Flutter project.'), null);
  assert.equal(purposeFromReadme('# x\n\n[Docs](a) | [API](b)'), null);
  assert.equal(purposeFromReadme(''), null);
  // A description written above the generator's text is used; anything after it belongs to the template.
  assert.equal(purposeFromReadme('# app\n\n社内の備品貸し出しを管理するアプリ。\n\nThis template provides a minimal setup to get React working in Vite.'), '社内の備品貸し出しを管理するアプリ。');
  assert.equal(purposeFromReadme('# app\n\nThis template provides a minimal setup to get React working in Vite.\n\nHMR and some ESLint rules are included.'), null);
  assert.equal(purposeFromReadme('# x\n\nFirst, run the development server:\n\n```\nnpm run dev\n```'), null);
  // WordPress plugin readme.txt from the scaffold.
  assert.equal(purposeFromReadme('=== Importer ===\nContributors: me\nTags: a, b\nLicense URI: https://www.gnu.org/licenses/gpl-2.0.html\n\nHere is a short description of the plugin.'), null);
  assert.equal(purposeFromReadme('=== Importer ===\nContributors: me\nStable tag: 0.1.0\n\n販売店リストのCSVを取り込むWordPressプラグイン。'), '販売店リストのCSVを取り込むWordPressプラグイン。');
});

test('長い説明は文の区切りで200字以内にし、区切れないときは省略記号を付ける', () => {
  const sentence = 'あ'.repeat(120) + '。';
  assert.equal(purposeFromReadme(`# x\n\n${sentence}${sentence}`), sentence);
  const long = purposeFromReadme(`# x\n\n${'い'.repeat(300)}`)!;
  assert.equal(long.length, 200); assert.ok(long.endsWith('…'));
});

test('READMEがない・使えないときは、package.json などの description を使い、ファイルは変えない', async () => {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-readme-')));
  const put = async (file: string, data: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); };
  try {
    await put('a/README.md', '# a\n\n請求書をPDFにしてBoxへアップロードするツール。');
    await put('a/package.json', JSON.stringify({ description: '使われないはずの説明' }));
    await put('b/README.md', '# b\n\nThis project was bootstrapped with Create React App.');
    await put('b/package.json', JSON.stringify({ description: 'Shows today\'s weather for the office.' }));
    await put('c/pyproject.toml', '[project]\nname="c"\ndescription="Exports Slack messages to CSV"');
    await put('d/pubspec.yaml', 'name: d\ndescription: A new Flutter project.');
    await put('e/readme.txt', 'Old PHP form that collects event sign-ups.');
    await put('outside/README.md', '# secret\n\nこれは範囲外のファイルです。');
    await mkdir(join(root, 'f'));
    await symlink(join(root, 'outside/README.md'), join(root, 'f/README.md'));
    assert.deepEqual(await suggestPurpose(join(root, 'a')), { text: '請求書をPDFにしてBoxへアップロードするツール。', source: 'README.md' });
    assert.deepEqual(await suggestPurpose(join(root, 'b')), { text: 'Shows today\'s weather for the office.', source: 'package.json' });
    assert.deepEqual(await suggestPurpose(join(root, 'c')), { text: 'Exports Slack messages to CSV', source: 'pyproject.toml' });
    assert.equal(await suggestPurpose(join(root, 'd')), null);
    assert.deepEqual(await suggestPurpose(join(root, 'e')), { text: 'Old PHP form that collects event sign-ups.', source: 'readme.txt' });
    assert.equal(await suggestPurpose(join(root, 'f')), null, 'a README linked from outside the project is not read');
    assert.equal(await suggestPurpose(join(root, 'missing')), null);
    assert.equal(await readFile(join(root, 'a/README.md'), 'utf8'), '# a\n\n請求書をPDFにしてBoxへアップロードするツール。');
  } finally { await rm(root, { recursive: true, force: true }); }
});
