import { defineConfig } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Isolated generated fixtures; never inspect or register the user's projects.
const fixtureRoot = process.env.OWNDAPP_TEST_ROOT || mkdtempSync(join(tmpdir(), 'owndapp-e2e-'));
process.env.OWNDAPP_TEST_ROOT = fixtureRoot;
for (const [file, content] of Object.entries({
  'photo-notes/package.json': JSON.stringify({ name: 'photo-notes', dependencies: { vue: '^3.5.0' } }),
  'photo-notes/package-lock.json': JSON.stringify({ name: 'photo-notes', lockfileVersion: 3, packages: {
    '': { name: 'photo-notes', dependencies: { vue: '^3.5.0' } },
    'node_modules/vue': { version: '3.5.13', resolved: 'https://registry.npmjs.org/vue/-/vue-3.5.13.tgz', dependencies: { '@vue/shared': '3.5.13' } },
    'node_modules/@vue/shared': { version: '3.5.13', resolved: 'https://registry.npmjs.org/@vue/shared/-/shared-3.5.13.tgz' },
  } }),
  'personal-portal/package.json': JSON.stringify({ name: 'personal-portal', dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
  'personal-portal/README.md': '# personal-portal\n\n[![build](https://img.shields.io/badge/build-ok-green.svg)](https://example.com)\n\n社内のお知らせと予定をまとめて表示するポータル。\n\n## 使い方',
  'image-worker/pyproject.toml': '[project]\nname="image-worker"\nrequires-python=">=3.12"',
  'image-worker/template.yaml': 'Resources:\n  Worker:\n    Type: AWS::Serverless::Function\n    Properties:\n      Runtime: python3.12',
  'log-tool/go.mod': 'module example.com/log-tool\n\ngo 1.23',
})) {
  const path = join(fixtureRoot, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
}

// A stand-in application bundle outside the scanned folder. The test server never launches it.
const testApp = join(fixtureRoot + '-apps', 'TestApp.app');
mkdirSync(join(testApp, 'Contents'), { recursive: true }); writeFileSync(join(testApp, 'Contents', 'Info.plist'), '<plist/>');

// Offline OSV answers for the browser test. The advisory is made up for the test and names no real issue.
const osvFixture = join(fixtureRoot + '-apps', 'osv.json');
writeFileSync(osvFixture, JSON.stringify({ '@vue/shared@3.5.13': [{ id: 'GHSA-test-0000-0001', summary: 'テスト用の架空のアドバイザリ', aliases: ['CVE-0000-0001'],
  affected: [{ package: { ecosystem: 'npm', name: '@vue/shared' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.5.14' }] }] }],
  database_specific: { severity: 'MODERATE' } }] }));

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4317', channel: 'chrome', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
    env: { OWNDAPP_PORT: '4317', OWNDAPP_DATA_DIR: join(fixtureRoot, '.owndapp'), OWNDAPP_TEST_PICK_FOLDER: fixtureRoot, OWNDAPP_TEST_PICK_APP: testApp, OWNDAPP_TEST_OSV: osvFixture },
  },
});
