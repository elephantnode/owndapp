import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundup, scoreCvss3, scoreSeverityEntry } from '../server/cvss.js';
import { dedupe, mergeAdvisories, toAdvisory, type OsvRecord } from '../server/osv.js';

const score = (vector: string) => { const r = scoreCvss3(vector); assert.ok(r.ok, `${vector}: ${!r.ok && r.reason}`); return r; };
const record = (id: string, extra: Partial<OsvRecord> = {}): OsvRecord => ({
  id, summary: `${id} の問題`, aliases: [], affected: [{ package: { ecosystem: 'npm', name: 'x' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] }] }], ...extra,
});
const cvss = (vector: string) => ({ severity: [{ type: vector.startsWith('CVSS:4') ? 'CVSS_V4' : 'CVSS_V3', score: vector }] });

test('CVSS v3.0/v3.1 の基本値を公式の式で計算する', () => {
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H').score, 9.8);
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H').severity, 'critical');
  assert.equal(score('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H').score, 9.8);
  assert.equal(score('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H').version, '3.0');
  // Changed scope uses its own impact formula, the 1.08 factor, and heavier privilege weights.
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H').score, 10);
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H').score, 9.9);
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H').score, 8.8);
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N').score, 6.1);
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N').severity, 'moderate');
  assert.equal(score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N').severity, 'low');
  // No impact scores 0.0, "None", which is not a severity.
  const zero = score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N');
  assert.equal(zero.score, 0); assert.equal(zero.severity, null);
  // Temporal and environmental metrics are allowed but do not change the base score; metric order does not matter.
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:U/RL:O/MAV:L').score, 9.8);
  assert.equal(score('CVSS:3.1/S:U/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H').score, 9.8);
  // Roundup avoids floating point error: 4.000000001 still rounds to 4.0.
  assert.equal(roundup(4.000000001), 4); assert.equal(roundup(4.02), 4.1);
});

test('不正なベクトルは採点せず、理由を残す', () => {
  for (const vector of ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H', 'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    'CVSS:3.1/AV:N/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZ:1', 'CVSS:3.1/', 'CVSS:3.2/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']) {
    const result = scoreCvss3(vector);
    assert.equal(result.ok, false, vector);
  }
  const v2 = scoreSeverityEntry('CVSS_V2', 'AV:N/AC:L/Au:N/C:P/I:P/A:P');
  assert.ok(!v2.ok && /v2/.test(v2.reason));
  const v4 = scoreSeverityEntry('CVSS_V4', 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N');
  assert.ok(!v4.ok && /v4/.test(v4.reason));
  // Plain numbers from 0 to 10 are scores on the v3 scale. v2 numbers use another scale.
  const numeric = scoreSeverityEntry('CVSS_V3', '7.5');
  assert.ok(numeric.ok && numeric.score === 7.5 && numeric.severity === 'high');
  assert.equal(scoreSeverityEntry('CVSS_V3', '10.5').ok, false);
  assert.equal(scoreSeverityEntry('CVSS_V2', '7.5').ok, false);
  assert.equal(scoreSeverityEntry('CVSS_V3', '').ok, false);
});

test('データベースのラベルとCVSSのうち高い方を採り、出所と食い違いを示す', () => {
  const higherCvss = toAdvisory('GHSA-a', record('GHSA-a', { database_specific: { severity: 'MODERATE' }, ...cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') }), 'x', '1.0.0');
  assert.equal(higherCvss.severity, 'critical'); assert.equal(higherCvss.severitySource, 'CVSS v3.1');
  assert.equal(higherCvss.severityScore, 9.8); assert.equal(higherCvss.severityConflict, true);
  assert.match(higherCvss.severityReason!, /食い違う/);
  assert.deepEqual(higherCvss.severityEvidence!.map(e => [e.source, e.severity]), [['GitHub Advisory Database', 'moderate'], ['CVSS v3.1', 'critical']]);
  const higherLabel = toAdvisory('GHSA-b', record('GHSA-b', { database_specific: { severity: 'HIGH' }, ...cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N') }), 'x', '1.0.0');
  assert.equal(higherLabel.severity, 'high'); assert.equal(higherLabel.severitySource, 'GitHub Advisory Database'); assert.equal(higherLabel.severityScore, 6.1);
  const agree = toAdvisory('GHSA-c', record('GHSA-c', { database_specific: { severity: 'CRITICAL' }, ...cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') }), 'x', '1.0.0');
  assert.equal(agree.severityConflict, false); assert.equal(agree.severitySource, 'GitHub Advisory Database'); assert.equal(agree.severityReason, undefined);
  // A record from another database is not credited to GitHub.
  const pysec = toAdvisory('PYSEC-1', record('PYSEC-1', cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')), 'x', '1.0.0');
  assert.equal(pysec.severity, 'critical'); assert.equal(pysec.severitySource, 'CVSS v3.1');
  const labelled = toAdvisory('PYSEC-2', record('PYSEC-2', { database_specific: { severity: 'HIGH' } }), 'x', '1.0.0');
  assert.equal(labelled.severitySource, 'PyPI Advisory Database');
});

test('採点できないCVSSは不明のまま、理由を付ける', () => {
  const v4 = toAdvisory('GHSA-v4', record('GHSA-v4', cvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')), 'x', '1.0.0');
  assert.equal(v4.severity, 'unknown'); assert.equal(v4.severitySource, null); assert.match(v4.severityReason!, /v4/);
  assert.equal(v4.cvss, 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 'the published vector is still shown');
  const v2 = toAdvisory('OSV-v2', record('OSV-v2', { severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C' }] }), 'x', '1.0.0');
  assert.equal(v2.severity, 'unknown'); assert.match(v2.severityReason!, /v2/);
  const malformed = toAdvisory('GHSA-bad', record('GHSA-bad', cvss('CVSS:3.1/AV:N/AC:L')), 'x', '1.0.0');
  assert.equal(malformed.severity, 'unknown'); assert.match(malformed.severityReason!, /欠けて/); assert.equal(malformed.severityScore, null);
  const zero = toAdvisory('GHSA-zero', record('GHSA-zero', cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')), 'x', '1.0.0');
  assert.equal(zero.severity, 'unknown'); assert.equal(zero.severityScore, 0); assert.match(zero.severityReason!, /0\.0/);
  // A malformed vector does not hide a usable label next to it.
  const mixed = toAdvisory('GHSA-mix', record('GHSA-mix', { database_specific: { severity: 'LOW' }, ...cvss('CVSS:3.1/AV:Q') }), 'x', '1.0.0');
  assert.equal(mixed.severity, 'low'); assert.equal(mixed.severityConflict, false);
  const none = toAdvisory('GHSA-none', record('GHSA-none'), 'x', '1.0.0');
  assert.equal(none.severity, 'unknown'); assert.equal(none.severityReason, '重大度の記載がありません');
  const missing = toAdvisory('GHSA-gone', undefined, 'x', '1.0.0');
  assert.equal(missing.severity, 'unknown'); assert.match(missing.severityReason!, /詳細を取得できません/);
});

test('CVSS の種類とベクトルの版が合わないもの、未知の種類は採点しない', () => {
  const v31 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const v40 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
  for (const [type, value] of [['CVSS_V4', v31], ['CVSS_V3', v40], ['CVSS_V2', v31], ['CVSS_V3', 'AV:N/AC:L/Au:N/C:P/I:P/A:P']]) {
    const result = scoreSeverityEntry(type, value);
    assert.ok(!result.ok && /一致しません/.test(result.reason), `${type} ${value}`);
  }
  // Numbers are read only under the known v3 and v4 types; an unknown type is never scored, vector or number.
  const v4number = scoreSeverityEntry('CVSS_V4', '9.3');
  assert.ok(v4number.ok && v4number.severity === 'critical');
  for (const [type, value] of [['CVSS_FOO', '7.5'], ['CVSS_FOO', v31], ['CVSS', '7.5'], [undefined, '7.5'], [7, '7.5']]) {
    const result = scoreSeverityEntry(type, value);
    assert.ok(!result.ok && /種類/.test(result.reason), `${String(type)} ${value}`);
  }
  // A score that is not a string is not read, even when it looks like a number.
  for (const value of [7.5, null, undefined, {}, ['7.5']]) assert.equal(scoreSeverityEntry('CVSS_V3', value).ok, false, String(value));
  assert.equal(scoreCvss3(7 as unknown as string).ok, false);
  // The v3.1 base score uses the exponent 15 of the scope-changed impact (13 belongs to the environmental modified impact).
  assert.equal(score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H').score, 10);
  assert.equal(score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:H/A:H').score, 9.0);
  // High impact makes the exponent matter: 15 gives 7.2, 13 would give 7.1.
  assert.equal(score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:H').score, 7.2);
});

test('affected[].severity は同じエコシステムと名前のパッケージの値だけを使う', () => {
  const v31 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const low = 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N';
  const scoped = (affected: OsvRecord['affected']) => record('OSV-s', { affected });
  const range = [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }];
  const r = scoped([
    { package: { ecosystem: 'npm', name: 'x' }, ranges: range, severity: [{ type: 'CVSS_V3', score: low }] },
    { package: { ecosystem: 'npm', name: 'other' }, ranges: range, severity: [{ type: 'CVSS_V3', score: v31 }] },
    { package: { ecosystem: 'PyPI', name: 'x' }, ranges: range, severity: [{ type: 'CVSS_V3', score: v31 }] },
  ]);
  const matched = toAdvisory('OSV-s', r, 'x', '1.0.0');
  assert.equal(matched.severity, 'low', "another package's or ecosystem's critical is not used");
  assert.equal(matched.severitySource, 'CVSS v3.1（npm x 向け）');
  assert.deepEqual(matched.severityEvidence!.map(e => [e.source, e.cvss]), [['CVSS v3.1（npm x 向け）', low]]);
  assert.equal(matched.cvss, low);
  // Only a different package carries severity: nothing applies here.
  const elsewhere = toAdvisory('OSV-s', r, 'y', '1.0.0');
  assert.equal(elsewhere.severity, 'unknown'); assert.equal(elsewhere.cvss, null); assert.equal(elsewhere.severityReason, '重大度の記載がありません');
  // The same name in another ecosystem is a different package.
  const pypi = toAdvisory('OSV-s', r, 'x', '1.0.0', 'PyPI');
  assert.equal(pypi.severity, 'critical'); assert.equal(pypi.severitySource, 'CVSS v3.1（PyPI x 向け）');
  // PyPI names compare normalized: Foo_Bar.baz, foo-bar-baz, and FOO--BAR_BAZ are one package.
  const normalized = scoped([{ package: { ecosystem: 'PyPI', name: 'Foo_Bar.baz' }, ranges: range, severity: [{ type: 'CVSS_V3', score: v31 }] }]);
  for (const name of ['foo-bar-baz', 'FOO--BAR_BAZ']) assert.equal(toAdvisory('OSV-s', normalized, name, '1.0.0', 'PyPI').severity, 'critical', name);
  assert.equal(toAdvisory('OSV-s', normalized, 'foobarbaz', '1.0.0', 'PyPI').severity, 'unknown');
  // A top-level score and a package-specific one are both kept, each with its own source.
  const both = toAdvisory('OSV-s', record('OSV-s', {
    severity: [{ type: 'CVSS_V3', score: low }],
    affected: [{ package: { ecosystem: 'npm', name: 'x' }, ranges: range, severity: [{ type: 'CVSS_V3', score: v31 }] }],
  }), 'x', '1.0.0');
  assert.deepEqual(both.severityEvidence!.map(e => [e.source, e.severity]), [['CVSS v3.1', 'low'], ['CVSS v3.1（npm x 向け）', 'critical']]);
  assert.equal(both.severity, 'critical'); assert.equal(both.severityConflict, true);
  // An unusable package-specific entry is reported with the package it was given for.
  const unsupported = toAdvisory('OSV-s', scoped([{ package: { ecosystem: 'npm', name: 'x' }, ranges: range, severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N' }] }]), 'x', '1.0.0');
  assert.equal(unsupported.severity, 'unknown'); assert.match(unsupported.severityReason!, /v4.*（npm x 向け）/);
});

test('想定外の形のJSONでも落ちず、不明として理由を残す', () => {
  const v31 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const broken = (extra: Record<string, unknown>) => record('GHSA-j', extra as unknown as Partial<OsvRecord>);
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['null entry', { severity: [null] }, /項目が不正/],
    ['string entry', { severity: ['CVSS_V3'] }, /項目が不正/],
    ['number type', { severity: [{ type: 3, score: v31 }] }, /種類が文字列ではありません/],
    ['missing type', { severity: [{ score: '9.8' }] }, /種類が文字列ではありません/],
    ['number score', { severity: [{ type: 'CVSS_V3', score: 9.8 }] }, /文字列ではありません/],
    ['unknown CVSS type', { severity: [{ type: 'CVSS_FOO', score: '9.8' }] }, /CVSS_FOO/],
    ['type mismatch', { severity: [{ type: 'CVSS_V4', score: v31 }] }, /一致しません/],
    ['severity object', { severity: { type: 'CVSS_V3', score: v31 } }, /配列ではありません/],
    ['severity string', { severity: v31 }, /配列ではありません/],
    ['affected severity object', { affected: [{ package: { ecosystem: 'npm', name: 'x' }, severity: { type: 'CVSS_V3', score: v31 } }] }, /配列ではありません（npm x 向け）/],
  ];
  for (const [label, extra, reason] of cases) {
    const a = toAdvisory('GHSA-j', broken(extra), 'x', '1.0.0');
    assert.equal(a.severity, 'unknown', label); assert.equal(a.severityScore, null, label); assert.match(a.severityReason!, reason, label);
  }
  // Non-CVSS kinds such as Ubuntu priorities are still left out silently.
  assert.equal(toAdvisory('GHSA-j', broken({ severity: [{ type: 'Ubuntu', score: 'high' }] }), 'x', '1.0.0').severityReason, '重大度の記載がありません');
  // Malformed aliases, affected entries, ranges, and references neither crash nor link anything.
  const odd = broken({ aliases: 'CVE-1', affected: [null, 'x', { package: null }, { package: { ecosystem: 'npm', name: 'x' }, ranges: [null, { type: 'SEMVER', events: [null, { introduced: 0 }, { introduced: '0' }, { fixed: '1.2.0' }] }] }], references: [null, 5, { url: 7 }, { url: 'https://example.test' }] });
  const a = toAdvisory('GHSA-j', odd, 'x', '1.0.0');
  assert.deepEqual(a.aliases, []); assert.equal(a.fixed, '1.2.0'); assert.deepEqual(a.references, ['https://example.test']);
  const mixedAliases = new Map<string, OsvRecord>([['GHSA-j', broken({ aliases: [null, 5, '', 'CVE-1'] })], ['CVE-1', record('CVE-1')], ['C', record('C')]]);
  assert.deepEqual(mergeAdvisories(['GHSA-j', 'CVE-1', 'C'], mixedAliases, 'x', '1.0.0').map(m => [m.id, m.aliases]), [['GHSA-j', ['CVE-1']], ['C', []]]);
  assert.equal(toAdvisory('GHSA-j', broken({ severity: null, aliases: { 0: 'CVE-1' } }), 'x', '1.0.0').severityReason, '重大度の記載がありません');
});

test('使える重大度があっても、使えなかったCVSSの理由は残す', () => {
  const v4 = toAdvisory('GHSA-l4', record('GHSA-l4', { database_specific: { severity: 'HIGH' }, ...cvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N') }), 'x', '1.0.0');
  assert.equal(v4.severity, 'high'); assert.equal(v4.severitySource, 'GitHub Advisory Database'); assert.equal(v4.severityConflict, false);
  assert.match(v4.severityReason!, /v4 のベクトルは未対応/);
  const malformed = toAdvisory('GHSA-lm', record('GHSA-lm', { database_specific: { severity: 'LOW' }, ...cvss('CVSS:3.1/AV:N/AC:L') }), 'x', '1.0.0');
  assert.equal(malformed.severity, 'low'); assert.match(malformed.severityReason!, /欠けて/);
  // A conflict names both claims and keeps the limitation of a third one.
  const conflict = toAdvisory('GHSA-lc', record('GHSA-lc', { database_specific: { severity: 'MODERATE' }, severity: [
    { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }, { type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C' }] }), 'x', '1.0.0');
  assert.equal(conflict.severity, 'critical'); assert.equal(conflict.severityConflict, true);
  assert.deepEqual(conflict.severityEvidence!.map(e => e.severity), ['moderate', 'critical']);
  assert.match(conflict.severityReason!, /食い違う.*moderate.*critical.*; GHSA-lc: CVSS v2/);
});

test('別名は報告順によらず推移的にまとめ、MAL→GHSAを代表にし、最も強い重大度を残す', () => {
  const records = new Map<string, OsvRecord>([
    ['CVE-2026-1', record('CVE-2026-1', { aliases: ['PYSEC-9'], ...cvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H') })],
    ['GHSA-zz', record('GHSA-zz', { aliases: ['CVE-2026-1'], database_specific: { severity: 'MODERATE' } })],
    ['PYSEC-9', record('PYSEC-9', { aliases: [], affected: [{ package: { ecosystem: 'npm', name: 'x' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.0' }] }] }] })],
    ['GHSA-other', record('GHSA-other', { database_specific: { severity: 'LOW' } })],
  ]);
  const ids = ['PYSEC-9', 'GHSA-other', 'CVE-2026-1', 'GHSA-zz'];
  const shape = (list: ReturnType<typeof mergeAdvisories>) => list.map(a => [a.id, a.aliases, a.severity, a.fixed]).sort();
  const forward = mergeAdvisories(ids, records, 'x', '1.0.0');
  const backward = mergeAdvisories([...ids].reverse(), records, 'x', '1.0.0');
  assert.deepEqual(shape(forward), shape(backward));
  const merged = forward.find(a => a.id === 'GHSA-zz')!;
  assert.deepEqual(merged.aliases, ['CVE-2026-1', 'PYSEC-9'], 'PYSEC-9 joins through CVE-2026-1');
  assert.equal(merged.severity, 'critical', 'the CVSS of an alias outranks the moderate label');
  assert.equal(merged.severityConflict, true);
  assert.equal(merged.fixed, '1.3.0', 'the highest branch fix covers every record');
  assert.equal(forward.length, 2);
  // Linked only through an id OSV did not report.
  const shared = new Map<string, OsvRecord>([['GHSA-a', record('GHSA-a', { aliases: ['CVE-X'] })], ['PYSEC-a', record('PYSEC-a', { aliases: ['CVE-X'] })]]);
  assert.deepEqual(mergeAdvisories(['PYSEC-a', 'GHSA-a'], shared, 'x', '1.0.0').map(a => [a.id, a.aliases]), [['GHSA-a', ['CVE-X', 'PYSEC-a']]]);
  assert.deepEqual(dedupe(['PYSEC-a', 'GHSA-a'], shared), ['GHSA-a']);
  // A malicious-package record is canonical and stays malicious even when listed last.
  const mal = new Map<string, OsvRecord>([['GHSA-m', record('GHSA-m', { aliases: ['MAL-2026-5'], database_specific: { severity: 'CRITICAL' } })]]);
  const malicious = mergeAdvisories(['GHSA-m', 'MAL-2026-5'], mal, 'x', '1.0.0');
  assert.deepEqual(malicious.map(a => [a.id, a.severity, a.severitySource, a.detailsAvailable]), [['MAL-2026-5', 'malicious', 'OpenSSF Malicious Packages', false]]);
});

test('取り下げは安全側に扱い、修正版は版の系列ごとに選ぶ', () => {
  const records = new Map<string, OsvRecord>([
    ['GHSA-w', record('GHSA-w', { aliases: ['CVE-W'], withdrawn: '2026-01-01T00:00:00Z', database_specific: { severity: 'CRITICAL' } })],
    ['CVE-W', record('CVE-W', { database_specific: { severity: 'LOW' } })],
    ['GHSA-gone', record('GHSA-gone', { withdrawn: '2026-01-01T00:00:00Z' })],
  ]);
  // A withdrawn record neither adds its severity nor survives alone; an active alias of it remains.
  const merged = mergeAdvisories(['GHSA-w', 'CVE-W', 'GHSA-gone'], records, 'x', '1.0.0');
  assert.deepEqual(merged.map(a => [a.id, a.severity]), [['CVE-W', 'low']]);
  // An id whose details are missing may or may not be withdrawn, so it is kept.
  assert.deepEqual(mergeAdvisories(['GHSA-unknown'], records, 'x', '1.0.0').map(a => a.id), ['GHSA-unknown']);
  const lines = record('GHSA-l', { affected: [{ package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '13.0.0' }, { fixed: '13.5.8' }, { introduced: '14.0.0' }, { fixed: '14.2.21' }] }] }] });
  const related = record('CVE-L', { aliases: ['GHSA-l'], affected: [{ package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '13.0.0' }, { fixed: '13.5.9' }, { introduced: '14.0.0' }, { fixed: '14.2.21' }] }] }] });
  const both = new Map([['GHSA-l', lines], ['CVE-L', related]]);
  assert.equal(mergeAdvisories(['GHSA-l', 'CVE-L'], both, 'next', '13.4.0')[0].fixed, '13.5.9');
  assert.equal(mergeAdvisories(['GHSA-l', 'CVE-L'], both, 'next', '14.1.0')[0].fixed, '14.2.21');
});


test('辞書の継承名を重大度・CVSSの種類・メトリクスとして採用しない', () => {
  assert.equal(scoreSeverityEntry('constructor', '9.8').ok, false);
  assert.equal(scoreCvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/__proto__:N').ok, false);
  const a = toAdvisory('OSV-invalid', record('OSV-invalid', { database_specific: { severity: '__proto__' } }), 'x', '1.0.0');
  assert.equal(a.severity, 'unknown');
});

test('CVSSの発行元を保存し、0.0と重大度ラベルの差異も示す', () => {
  const a = toAdvisory('OSV-source', record('OSV-source', { severity: [{ type: 'CVSS_V3', score: '9.8', source: 'https://example.org/advisory' }] }), 'x', '1.0.0');
  assert.ok(a.severityEvidence!.some(e => e.source.includes('https://example.org/advisory')));
  const conflict = toAdvisory('OSV-zero', record('OSV-zero', { database_specific: { severity: 'HIGH' }, severity: [{ type: 'CVSS_V3', score: '0.0' }] }), 'x', '1.0.0');
  assert.equal(conflict.severity, 'high');
  assert.equal(conflict.severityConflict, true);
});
