import type { Severity } from '../shared/types.js';

// CVSS v3.0 / v3.1 base scores, following the FIRST specification (https://www.first.org/cvss/v3.1/specification-document).
// v2 and v4 vectors are not scored here: v2 uses a different scale, and v4 needs the full MacroVector lookup tables.

export type CvssScore =
  | { ok: true; version: '3.0' | '3.1' | null; score: number; severity: Severity | null; vector: string | null }
  | { ok: false; reason: string };

const metrics: Record<string, string[]> = {
  AV: ['N', 'A', 'L', 'P'], AC: ['L', 'H'], PR: ['N', 'L', 'H'], UI: ['N', 'R'], S: ['U', 'C'], C: ['H', 'L', 'N'], I: ['H', 'L', 'N'], A: ['H', 'L', 'N'],
  E: ['X', 'U', 'P', 'F', 'H'], RL: ['X', 'O', 'T', 'W', 'U'], RC: ['X', 'U', 'R', 'C'],
  CR: ['X', 'L', 'M', 'H'], IR: ['X', 'L', 'M', 'H'], AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'], MAC: ['X', 'L', 'H'], MPR: ['X', 'N', 'L', 'H'], MUI: ['X', 'N', 'R'], MS: ['X', 'U', 'C'],
  MC: ['X', 'H', 'L', 'N'], MI: ['X', 'H', 'L', 'N'], MA: ['X', 'H', 'L', 'N'],
};
const base = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];
const weight = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as Record<string, number>, AC: { L: 0.77, H: 0.44 } as Record<string, number>,
  UI: { N: 0.85, R: 0.62 } as Record<string, number>, CIA: { H: 0.56, L: 0.22, N: 0 } as Record<string, number>,
  // Privileges weigh more when the scope changes.
  PR: { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } } as Record<string, Record<string, number>>,
};

/** The specification's Roundup: the smallest one-decimal number not below the input, robust to floating point error. */
export function roundup(value: number) {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** Qualitative rating. 0.0 is "None", which is not a severity, so it returns null. */
export function ratingOf(score: number): Severity | null {
  return score === 0 ? null : score < 4 ? 'low' : score < 7 ? 'moderate' : score < 9 ? 'high' : 'critical';
}

/** Base score of a CVSS v3.0 or v3.1 vector. Unknown, duplicated, invalid, or missing base metrics make it malformed. */
export function scoreCvss3(vector: string): CvssScore {
  const match = typeof vector === 'string' ? /^CVSS:(3\.[01])\/(.+)$/.exec(vector.trim()) : null;
  if (!match) return { ok: false, reason: 'CVSS v3 の形式ではありません' };
  const values = new Map<string, string>();
  for (const part of match[2].split('/')) {
    const [key, value, extra] = part.split(':');
    if (extra !== undefined || !key || !value || (!Object.hasOwn(metrics, key) || !metrics[key].includes(value)) || values.has(key)) return { ok: false, reason: `CVSS の値が不正です（${part}）` };
    values.set(key, value);
  }
  const missing = base.filter(key => !values.has(key));
  if (missing.length) return { ok: false, reason: `CVSS の基本値が欠けています（${missing.join(', ')}）` };
  const m = (key: string) => values.get(key)!;
  const changed = m('S') === 'C';
  const iss = 1 - (1 - weight.CIA[m('C')]) * (1 - weight.CIA[m('I')]) * (1 - weight.CIA[m('A')]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * weight.AV[m('AV')] * weight.AC[m('AC')] * weight.PR[m('S')][m('PR')] * weight.UI[m('UI')];
  const score = impact <= 0 ? 0 : roundup(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));
  return { ok: true, version: match[1] as '3.0' | '3.1', score, severity: ratingOf(score), vector: `CVSS:${match[1]}/${match[2]}` };
}

const declared: Record<string, string> = { CVSS_V2: '2', CVSS_V3: '3', CVSS_V4: '4' };

/**
 * Scores one OSV severity entry, which arrives as untrusted JSON. Only the OSV types CVSS_V2, CVSS_V3, and CVSS_V4 are read.
 * Accepts v3.0/v3.1 vectors under CVSS_V3, and plain numeric scores from 0 to 10 under CVSS_V3 or CVSS_V4 (their rating scales match).
 * v2 and v4 vectors, numeric v2 scores, and vectors of another version than the type names are reported rather than guessed.
 */
export function scoreSeverityEntry(type: unknown, raw: unknown): CvssScore {
  if (typeof type !== 'string') return { ok: false, reason: 'CVSS の種類が文字列ではありません' };
  const version = Object.hasOwn(declared, type) ? declared[type] : undefined;
  if (!version) return { ok: false, reason: `CVSS の種類「${type}」は判別できません` };
  if (typeof raw !== 'string') return { ok: false, reason: `${type} の値が文字列ではありません` };
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'CVSS の値が空です' };
  if (/^\d+(\.\d+)?$/.test(value)) {
    if (version === '2') return { ok: false, reason: 'CVSS v2 の数値は尺度が異なるため使いません' };
    const score = Number(value);
    if (!(score >= 0 && score <= 10)) return { ok: false, reason: `CVSS の数値が範囲外です（${value}）` };
    return { ok: true, version: null, score, severity: ratingOf(score), vector: null };
  }
  const found = /^CVSS:(\d+)\./.exec(value)?.[1] ?? (/(^|\/)Au:[MSN](\/|$)/.test(value) ? '2' : null);
  if (found && found !== version) return { ok: false, reason: `種類 ${type} とベクトルの版（CVSS v${found}）が一致しません` };
  if (version === '3') return scoreCvss3(value);
  if (version === '4') return { ok: false, reason: 'CVSS v4 のベクトルは未対応のため採点しません' };
  return { ok: false, reason: 'CVSS v2 のベクトルは未対応のため採点しません' };
}
