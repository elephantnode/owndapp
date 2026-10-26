import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemo } from '../src/memo.js';
import type { Dependency, Project, QueueItem } from '../shared/types.js';

const dep = (name: string, version: string, direct: boolean, extra: Partial<Dependency> = {}): Dependency =>
  ({ ecosystem: 'npm', name, version, requested: direct ? `^${version}` : null, direct, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '', ...extra });
const item = (id: string, severity: QueueItem['advisory']['severity'], fixed: string | null, dependencies: Dependency[], extra: Partial<QueueItem> = {}): QueueItem => ({
  projectId: 'p', advisory: { id, aliases: [], summary: `${id} の概要`, severity, severitySource: null, cvss: null, fixed, published: null, modified: null, references: [], detailsAvailable: true },
  dependencies, status: 'open', note: '', reviewBy: null, updatedAt: null, resolvedAt: null, priority: 'high', ...extra });
const project = { id: 'p', name: 'invoice-app', path: '/Users/developer/01_project/invoice-app', lifecycle: 'maintained', exposure: 'public' } as Project;

test('対策メモは未解消のものだけをパッケージの版ごとにまとめ、直接・間接で対応案を変える', () => {
  const memo = buildMemo(project, [
    item('GHSA-a', 'high', '4.17.19', [dep('lodash', '4.17.15', true)]),
    item('GHSA-b', 'critical', '4.17.21', [dep('lodash', '4.17.15', true)]),
    item('GHSA-c', 'moderate', '3.0.8', [dep('nanoid', '3.0.2', false)], { priority: 'medium' }),
    item('GHSA-d', 'low', null, [dep('minimist', '1.2.0', false)], { status: 'not-applicable' }),
    item('GHSA-e', 'high', '2.0.0', [dep('old', '1.0.0', true)], { status: 'resolved' }),
  ], '2026-10-20T05:00:00Z');
  assert.match(memo, /^# 脆弱性の対策メモ: invoice-app/);
  assert.match(memo, /公開状況: 公開 \/ 管理状態: 運用中/);
  assert.match(memo, /対応が必要なもの: 3件（3種類のアドバイザリ、2個のパッケージの版）/);
  // lodash: both advisories under one heading, target the highest fixed version.
  assert.match(memo, /## lodash@4\.17\.15（直接依存・本番・`package-lock\.json`）/);
  assert.ok(memo.indexOf('GHSA-b') < memo.indexOf('GHSA-a'), 'most severe first');
  assert.match(memo, /`lodash` を 4\.17\.21 以上/);
  assert.match(memo, /今の宣言は `\^4\.17\.15`/);
  assert.match(memo, /## nanoid@3\.0\.2（間接依存/);
  assert.match(memo, /`npm ls nanoid`/);
  assert.ok(memo.indexOf('lodash@') < memo.indexOf('nanoid@'), 'higher priority package first');
  assert.ok(!memo.includes('GHSA-d') && !memo.includes('GHSA-e'), 'not-applicable and resolved are left out');
  assert.match(memo, /npm audit fix --force/);
});

test('対応が必要なものがないときもメモを作れる', () => {
  const memo = buildMemo({ ...project, exposure: undefined }, [], null);
  assert.match(memo, /公開状況: 不明/);
  assert.match(memo, /照会: 未照会/);
  assert.match(memo, /対応が必要な既知の脆弱性はありません/);
});

test('npm以外の依存は見出しに言語を添え、宣言のファイルと経路の調べ方をその道具に合わせる', () => {
  const memo = buildMemo(project, [
    item('GHSA-dj', 'high', '4.2.2', [dep('django', '4.2.1', true, { ecosystem: 'PyPI', file: 'requirements.txt', requested: '==4.2.1' })]),
    item('GHSA-st', 'moderate', '0.37.0', [dep('starlette', '0.36.3', false, { ecosystem: 'PyPI', file: 'uv.lock' })]),
    item('GHSA-gz', 'high', '7.4.5', [dep('guzzlehttp/psr7', '1.8.0', false, { ecosystem: 'Packagist', file: 'composer.lock' })]),
    item('GHSA-pn', 'high', '1.0.1', [dep('nanoid', '1.0.0', false, { file: 'pnpm-lock.yaml' })]),
  ], '2026-10-23T05:00:00Z');
  assert.match(memo, /## Python: django@4\.2\.1（直接依存/);
  assert.match(memo, /requirements\.txt の `django` を 4\.2\.2 以上/);
  assert.match(memo, /`uv tree --invert --package starlette`/);
  assert.match(memo, /`composer why guzzlehttp\/psr7`/);
  assert.match(memo, /`pnpm why nanoid`/);
  assert.match(memo, /## nanoid@1\.0\.0/, 'npm headings stay as before');
});

test('修正版を影響版ごとに保持し、不明と情報不足をメモにも示す', () => {
  const one = dep('pkg', '1.0.0', true), two = dep('pkg', '2.0.0', true);
  const first = item('GHSA-shared', 'critical', '1.0.1', [one]);
  const second = item('GHSA-shared', 'critical', '2.0.3', [two]);
  const unknown = item('GHSA-unknown', 'unknown', null, [dep('other', '1.0.0', true)], { priority: 'review', retained: true });
  unknown.advisory.detailsAvailable = false;
  const memo = buildMemo(project, [{ ...first, dependencies: [one, two], advisoryVariants: [{ dependency: one, advisory: first.advisory }, { dependency: two, advisory: second.advisory }] }, unknown], '2026-10-26');
  assert.match(memo, /## pkg@1\.0\.0[\s\S]*?→ 修正版 1\.0\.1/);
  assert.match(memo, /## pkg@2\.0\.0[\s\S]*?→ 修正版 2\.0\.3/);
  assert.match(memo, /重大度不明・優先度要確認/);
  assert.match(memo, /前回の情報を保持/);
  assert.match(memo, /詳細情報を取得できていません/);
});
