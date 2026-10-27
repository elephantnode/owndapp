import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGoMod } from '../server/go-mod.js';
import { parseGemfileLock } from '../server/gemfile-lock.js';
import { parentPomPath, parsePom } from '../server/maven-pom.js';
import { readDependencies, filesChanged, dependencyStatusOf } from '../server/dependencies.js';
import { canonicalRoot } from '../server/scanner.js';
import { fixedVersion, fixtureClient, type OsvRecord } from '../server/osv.js';
import { Store } from '../server/store.js';
import { check, preview } from '../server/vulnerabilities.js';
import { compareVersions } from '../shared/semver.js';
import type { Dependency } from '../shared/types.js';

const find = (rows: Dependency[], name: string) => rows.filter(d => d.name === name);
async function fixture(fn: (root: string, put: (path: string, text: string) => Promise<void>) => Promise<void>) {
  const root = await canonicalRoot(await mkdtemp(join(tmpdir(), 'owndapp-ecosystems-')));
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  try { await fn(root, put); } finally { await rm(root, { recursive: true, force: true }); }
}

test('go.mod: require のブロックと1行形式、indirect、replace を読み、go 1.17 未満は直接依存のみとする', () => {
  const mod = `module example.com/app

go 1.22

require github.com/gin-gonic/gin v1.9.1

require (
\tgolang.org/x/text v0.3.5 // indirect
\t"github.com/acme/forked" v1.0.0
\tgithub.com/acme/local v0.1.0
\tgithub.com/old/name v1.2.0 // indirect
)

replace github.com/acme/local => ../local

replace (
\tgithub.com/acme/forked v1.0.0 => github.com/acme/fork-of-forked v1.0.1
)

exclude golang.org/x/net v0.1.0
// require github.com/commented/out v1.0.0
`;
  const parsed = parseGoMod(mod, 'svc');
  assert.equal(parsed.status, 'ok'); assert.equal(parsed.format, 'Go modules');
  const rows = parsed.dependencies;
  assert.deepEqual(find(rows, 'github.com/gin-gonic/gin')[0], { ecosystem: 'Go', name: 'github.com/gin-gonic/gin', version: '1.9.1', requested: 'v1.9.1', direct: true, scope: 'unknown', source: 'registry-unrecorded', file: 'svc/go.mod', component: 'svc' });
  assert.deepEqual([find(rows, 'golang.org/x/text')[0].direct, find(rows, 'golang.org/x/text')[0].requested], [false, null]);
  // The build uses the replacement module, so that is what is checked. A local replacement is never sent.
  assert.equal(find(rows, 'github.com/acme/forked').length, 0);
  assert.deepEqual([find(rows, 'github.com/acme/fork-of-forked')[0].version, find(rows, 'github.com/acme/fork-of-forked')[0].source], ['1.0.1', 'registry-unrecorded']);
  assert.deepEqual([find(rows, 'github.com/acme/local')[0].version, find(rows, 'github.com/acme/local')[0].source], ['0.1.0', 'file']);
  assert.equal(find(rows, 'golang.org/x/net').length, 0, 'exclude is not a dependency');
  assert.equal(find(rows, 'github.com/commented/out').length, 0);

  const old = parseGoMod('module example.com/old\n\ngo 1.16\n\nrequire golang.org/x/text v0.3.5\n', '');
  assert.equal(old.status, 'direct-only'); assert.match(old.message, /go 1\.16.*Go 1\.17/);
  assert.equal(parseGoMod('module example.com/none\n', '').status, 'direct-only', 'no go directive means an old module');
  assert.equal(parseGoMod('require golang.org/x/text v0.3.5\n', '').status, 'invalid');
});

const gemfileLock = `GIT
  remote: https://github.com/acme/forked-gem.git
  revision: 0123456789abcdef0123456789abcdef01234567
  specs:
    forked-gem (0.3.0)

PATH
  remote: engines/billing
  specs:
    billing (0.1.0)
      rails (>= 7.0)

GEM
  remote: https://rubygems.org/
  specs:
    nokogiri (1.16.0-arm64-darwin)
      racc (~> 1.4)
    nokogiri (1.16.0-x86_64-linux)
      racc (~> 1.4)
    racc (1.7.3)
    rack (2.2.3)
    rails (7.1.0.rc1)

PLATFORMS
  arm64-darwin
  x86_64-linux

DEPENDENCIES
  billing!
  forked-gem!
  nokogiri
  rack (~> 2.2)
  rails (= 7.1.0.rc1)

BUNDLED WITH
   2.5.3
`;

test('Gemfile.lock: GEM・GIT・PATH の取得元、プラットフォーム別の重複、DEPENDENCIES の直接依存', () => {
  const parsed = parseGemfileLock(gemfileLock, 'source "https://rubygems.org"\n', '');
  assert.equal(parsed.status, 'ok'); assert.equal(parsed.format, 'Bundler');
  const rows = parsed.dependencies;
  assert.deepEqual(find(rows, 'rack')[0], { ecosystem: 'RubyGems', name: 'rack', version: '2.2.3', requested: '~> 2.2', direct: true, scope: 'unknown', source: 'registry', file: 'Gemfile.lock', component: '' });
  assert.deepEqual(find(rows, 'nokogiri').map(d => [d.version, d.direct, d.requested]), [['1.16.0', true, null]], 'one row for both platforms');
  assert.deepEqual([find(rows, 'racc')[0].direct, find(rows, 'racc')[0].source], [false, 'registry']);
  assert.equal(find(rows, 'rails')[0].version, '7.1.0.rc1');
  assert.deepEqual([find(rows, 'forked-gem')[0].source, find(rows, 'forked-gem')[0].direct], ['git', true]);
  assert.equal(find(rows, 'billing')[0].source, 'file');

  // Another gem server is kept apart; several servers in one section do not say which gem came from which.
  const privateServer = parseGemfileLock('GEM\n  remote: https://gems.example.test/\n  specs:\n    internal (1.0.0)\n\nDEPENDENCIES\n  internal\n', '', '');
  assert.equal(privateServer.dependencies[0].source, 'other-registry');
  const mixed = parseGemfileLock('GEM\n  remote: https://rubygems.org/\n  remote: https://gems.example.test/\n  specs:\n    internal (1.0.0)\n\nDEPENDENCIES\n  internal\n', '', '');
  assert.equal(mixed.dependencies[0].source, 'unknown');

  assert.equal(parseGemfileLock(gemfileLock, null, '').status, 'mismatch');
  const missing = parseGemfileLock('GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n\nDEPENDENCIES\n  rack\n  tzinfo-data\n', '', '');
  assert.equal(missing.status, 'mismatch'); assert.match(missing.message, /tzinfo-data/);
  assert.equal(parseGemfileLock('not a lockfile', '', '').status, 'invalid');
});

const parentPom = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>parent</artifactId>
  <version>1.4.0</version>
  <packaging>pom</packaging>
  <modules><module>app</module></modules>
  <properties>
    <log4j.version>2.14.1</log4j.version>
    <jackson.version>2.9.10</jackson.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>\${jackson.version}</version></dependency>
      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.2.0</version><type>pom</type><scope>import</scope></dependency>
    </dependencies>
  </dependencyManagement>
</project>
`;
const appPom = `<project>
  <parent><groupId>com.example</groupId><artifactId>parent</artifactId><version>1.4.0</version></parent>
  <artifactId>app</artifactId>
  <properties><jackson.version>2.13.0</jackson.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version>
      <exclusions><exclusion><groupId>org.excluded</groupId><artifactId>gone</artifactId></exclusion></exclusions>
    </dependency>
    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>
    <dependency><groupId>com.example</groupId><artifactId>shared</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>[1.7,2.0)</version><optional>true</optional></dependency>
    <dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency>
    <dependency><groupId>com.vendor</groupId><artifactId>legacy</artifactId><version>1.0</version><scope>system</scope></dependency>
    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId><version>1.0</version></dependency> -->
  </dependencies>
  <build><plugins><plugin><artifactId>maven-plugin</artifactId><dependencies>
    <dependency><groupId>plugin</groupId><artifactId>dep</artifactId><version>1.0</version></dependency>
  </dependencies></plugin></plugins></build>
  <profiles><profile><dependencies><dependency><groupId>profile</groupId><artifactId>dep</artifactId><version>1.0</version></dependency></dependencies></profile></profiles>
</project>
`;

test('pom.xml: プロパティ・親POM・dependencyManagement から直接依存の版を決め、決められないものは照会しない', () => {
  const parsed = parsePom(appPom, 'app', [parentPom]);
  assert.equal(parsed.status, 'unpinned'); assert.equal(parsed.format, 'Maven (pom.xml)');
  assert.match(parsed.message, /版を決められない依存が2件/); assert.match(parsed.message, /BOMが1件/); assert.match(parsed.message, /推移的な依存は照会しません/);
  const rows = parsed.dependencies;
  assert.deepEqual(find(rows, 'org.apache.logging.log4j:log4j-core')[0], { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1', requested: '${log4j.version}', direct: true, scope: 'prod', source: 'registry-unrecorded', file: 'app/pom.xml', component: 'app' });
  // The child's property overrides the parent's, also inside a version the parent manages.
  assert.equal(find(rows, 'com.fasterxml.jackson.core:jackson-databind')[0].version, '2.13.0');
  assert.equal(find(rows, 'com.example:shared')[0].version, '1.4.0', 'project.version falls back to the parent version');
  assert.equal(find(rows, 'junit:junit')[0].scope, 'dev');
  assert.deepEqual([find(rows, 'org.slf4j:slf4j-api')[0].version, find(rows, 'org.slf4j:slf4j-api')[0].scope], [null, 'optional'], 'a range is not a version');
  assert.equal(find(rows, 'org.springframework:spring-core')[0].version, null, 'managed by an imported BOM');
  assert.equal(find(rows, 'com.vendor:legacy')[0].source, 'file');
  for (const name of ['org.excluded:gone', 'commented:out', 'plugin:dep', 'profile:dep']) assert.equal(find(rows, name).length, 0, name);

  const complete = parsePom('<project><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId><version>1.0</version></dependency></dependencies></project>', '');
  assert.equal(complete.status, 'direct-only'); assert.doesNotMatch(complete.message, /版を決められない/);
  assert.match(parsePom(appPom, 'app').message, /親POMがプロジェクト内に見つからない/);
  assert.equal(parsePom('<html></html>', '').status, 'invalid');

  assert.equal(parentPomPath(appPom, 'app'), 'pom.xml');
  assert.equal(parentPomPath('<project><parent><relativePath>../build/parent</relativePath></parent></project>', 'svc/app'), 'svc/build/parent/pom.xml');
  assert.equal(parentPomPath('<project><parent><relativePath/></parent></project>', 'app'), null, 'an empty relativePath means a repository lookup');
  assert.equal(parentPomPath('<project><parent><relativePath /><version>1</version></parent></project>', 'app'), null);
  assert.equal(parentPomPath(appPom, ''), null, 'never outside the project');
});

test('RubyGems・Maven・Goの版の並びで修正版を選ぶ', () => {
  const sorted = (ecosystem: Parameters<typeof compareVersions>[0], list: string[]) => [...list].sort((a, b) => compareVersions(ecosystem, a, b));
  assert.deepEqual(sorted('RubyGems', ['1.0.0', '1.0.0.rc1', '0.9.10', '1.0.0.pre', '1.0.0.1', '1.0.0.rc2']), ['0.9.10', '1.0.0.pre', '1.0.0.rc1', '1.0.0.rc2', '1.0.0', '1.0.0.1']);
  assert.deepEqual(sorted('Maven', ['1.0', '1.0-sp', '1.0-SNAPSHOT', '1.0-rc1', '1.0-beta', '1.0-alpha-2', '1.0-alpha-10', '1.0-m1', '1.0.1', '1.0-1']),
    ['1.0-alpha-2', '1.0-alpha-10', '1.0-beta', '1.0-m1', '1.0-rc1', '1.0-SNAPSHOT', '1.0', '1.0-sp', '1.0-1', '1.0.1']);
  for (const [a, b] of [['1', '1.0.0'], ['1.0-ga', '1.0'], ['1.0-final', '1'], ['1.0-cr1', '1.0-rc1']]) assert.equal(compareVersions('Maven', a, b), 0, `${a} = ${b}`);
  assert.ok(compareVersions('Maven', '2.14.1', '2.15.0') < 0 && compareVersions('Maven', '2.17.0', '2.17.1') < 0 && compareVersions('Maven', '2.9.10', '2.13.0') < 0);
  assert.ok(compareVersions('Go', '0.3.5', 'v0.3.8') < 0 && compareVersions('Go', '0.0.0-20210101000000-abcdef123456', '0.1.0') < 0);

  const log4j: OsvRecord = { id: 'GHSA-jfh8-c2jp-5v3q', affected: [{ package: { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core' },
    ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.13.0' }, { fixed: '2.15.0' }, { introduced: '2.0-beta9' }, { fixed: '2.12.2' }] }] }] };
  assert.equal(fixedVersion(log4j, 'org.apache.logging.log4j:log4j-core', '2.14.1', 'Maven'), '2.15.0');
  assert.equal(fixedVersion(log4j, 'org.apache.logging.log4j:log4j-core', '2.0-rc1', 'Maven'), '2.12.2', 'rc1 comes after beta9');
  const rails: OsvRecord = { id: 'GHSA-rails', affected: [{ package: { ecosystem: 'RubyGems', name: 'rails' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '7.1.0' }] }] }] };
  assert.equal(fixedVersion(rails, 'rails', '7.1.0.rc1', 'RubyGems'), '7.1.0', 'a release candidate is before the release');
});

test('Go・Bundler・Mavenを読み取り、親POMの変更を検知し、未対応のgo.workとGradleを残す', async () => fixture(async (root, put) => {
  await put('go/go.mod', 'module example.com/tool\n\ngo 1.23\n\nrequire golang.org/x/text v0.3.5 // indirect\n');
  await put('go.work', 'go 1.23\n\nuse ./go\n');
  await put('ruby/Gemfile', 'source "https://rubygems.org"\ngem "rack"\n');
  await put('ruby/Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n\nDEPENDENCIES\n  rack\n');
  await put('Gemfile', 'source "https://rubygems.org"\n');
  await put('pom.xml', parentPom);
  await put('app/pom.xml', appPom);
  await put('android/build.gradle', 'plugins {}\n');
  const components = ['go', 'ruby', 'app', 'android'].map(path => ({ path, technologies: [], evidence: [] }));
  const read = await readDependencies({ path: root, components } as any);
  const byPath = Object.fromEntries(read.files.map(f => [f.path, f]));
  assert.equal(byPath['go/go.mod'].status, 'ok');
  assert.equal(byPath['ruby/Gemfile.lock'].status, 'ok');
  assert.equal(byPath['Gemfile'].status, 'no-lock'); assert.match(byPath['Gemfile'].message, /Gemfile\.lock/);
  assert.equal(byPath['pom.xml'].status, 'direct-only', 'a parent POM with no dependencies of its own');
  assert.equal(byPath['app/pom.xml'].status, 'unpinned');
  assert.deepEqual(Object.keys(byPath['app/pom.xml'].hashes).sort(), ['app/pom.xml', 'pom.xml']);
  assert.deepEqual([byPath['go.work'].status, byPath['android/build.gradle'].status], ['unsupported', 'unsupported']);
  assert.equal(read.status, 'partial');
  assert.equal(find(read.dependencies, 'org.apache.logging.log4j:log4j-core')[0].version, '2.14.1');
  assert.equal(find(read.dependencies, 'golang.org/x/text')[0].file, 'go/go.mod');
  // direct-only and unpinned files count as read; only the unsupported ones make the project partial.
  assert.equal(dependencyStatusOf(read.files.filter(f => f.status !== 'unsupported')), 'complete');
  assert.equal(await filesChanged(root, read.files), false);
  await put('pom.xml', parentPom.replace('2.14.1', '2.17.1'));
  assert.equal(await filesChanged(root, read.files), true, 'a parent POM decides versions, so its change is noticed');
}));

test('Go・Ruby・Mavenの依存を送信確認に含め、ローカルや版不明のものは送らない', async () => fixture(async (root, put) => {
  await put('go.mod', 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/text v0.3.5\n\texample.com/local v0.0.0\n)\n\nreplace example.com/local => ./local\n');
  await put('Gemfile', '');
  await put('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n\nDEPENDENCIES\n  rack\n');
  await put('pom.xml', '<project><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency><dependency><groupId>x</groupId><artifactId>managed</artifactId></dependency></dependencies></project>');
  const store = new Store(':memory:');
  try {
    const [id] = store.import('eco', [{ id: 'eco', name: 'eco', path: root, technologies: [], components: [], evidence: [], fingerprint: 'eco', registered: false }]).projectIds;
    const read = await readDependencies({ path: root, components: [] });
    store.saveDependencies({ projectId: id, readAt: new Date().toISOString(), status: read.status, files: read.files, total: read.dependencies.length, direct: read.dependencies.filter(d => d.direct).length }, read.dependencies);
    const shown = preview(store, [id]);
    assert.equal(shown.packageVersions, 3);
    const records: Record<string, OsvRecord[]> = {
      'Go:golang.org/x/text@0.3.5': [{ id: 'GO-2021-0113', affected: [{ package: { ecosystem: 'Go', name: 'golang.org/x/text' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.3.7' }] }] }] }],
      'RubyGems:rack@2.2.3': [{ id: 'GHSA-rack', database_specific: { severity: 'HIGH' }, affected: [{ package: { ecosystem: 'RubyGems', name: 'rack' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.2.8.1' }] }] }] }],
      'Maven:org.apache.logging.log4j:log4j-core@2.14.1': [{ id: 'GHSA-jfh8-c2jp-5v3q', severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H' }],
        affected: [{ package: { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.13.0' }, { fixed: '2.15.0' }] }] }] }],
    };
    const result = await check(store, fixtureClient(records), [id]);
    assert.equal(result.queried, 3);
    const saved = store.vulnerabilityCheck(id)!;
    assert.deepEqual(saved.notSent, { file: 1, 'no-version': 1 });
    const fixes = Object.fromEntries(saved.findings.map(f => [f.dependency.name, [f.advisories[0].fixed, f.advisories[0].severity]]));
    assert.deepEqual(fixes, { 'golang.org/x/text': ['0.3.7', 'unknown'], rack: ['2.2.8.1', 'high'], 'org.apache.logging.log4j:log4j-core': ['2.15.0', 'critical'] });
  } finally { store.close(); }
}));
