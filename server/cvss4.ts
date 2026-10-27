import type { CvssScore } from './cvss.js';
import { ratingOf } from './cvss.js';

// CVSS v4.0 scores, following the FIRST specification (https://www.first.org/cvss/v4.0/specification-document).
// Ported from the reference calculator, Copyright FIRST, Red Hat, and contributors, BSD-2-Clause
// (https://github.com/RedHatProductSecurity/cvss-v4-calculator, cvss40.js at b0930b7). See THIRD_PARTY_NOTICES.md.

// Metrics in the order the specification requires. The first 11 (Base) are mandatory.
const metrics: [string, string[]][] = [
  ['AV', ['N', 'A', 'L', 'P']], ['AC', ['L', 'H']], ['AT', ['N', 'P']], ['PR', ['N', 'L', 'H']], ['UI', ['N', 'P', 'A']],
  ['VC', ['N', 'L', 'H']], ['VI', ['N', 'L', 'H']], ['VA', ['N', 'L', 'H']], ['SC', ['N', 'L', 'H']], ['SI', ['N', 'L', 'H']], ['SA', ['N', 'L', 'H']],
  ['E', ['X', 'A', 'P', 'U']],
  ['CR', ['X', 'H', 'M', 'L']], ['IR', ['X', 'H', 'M', 'L']], ['AR', ['X', 'H', 'M', 'L']],
  ['MAV', ['X', 'N', 'A', 'L', 'P']], ['MAC', ['X', 'L', 'H']], ['MAT', ['X', 'N', 'P']], ['MPR', ['X', 'N', 'L', 'H']], ['MUI', ['X', 'N', 'P', 'A']],
  ['MVC', ['X', 'H', 'L', 'N']], ['MVI', ['X', 'H', 'L', 'N']], ['MVA', ['X', 'H', 'L', 'N']], ['MSC', ['X', 'H', 'L', 'N']],
  ['MSI', ['X', 'S', 'H', 'L', 'N']], ['MSA', ['X', 'S', 'H', 'L', 'N']],
  ['S', ['X', 'N', 'P']], ['AU', ['X', 'N', 'Y']], ['R', ['X', 'A', 'U', 'I']], ['V', ['X', 'D', 'C']], ['RE', ['X', 'L', 'M', 'H']],
  ['U', ['X', 'Clear', 'Green', 'Amber', 'Red']],
];
const mandatory = 11;

// Score of the highest severity vector of each MacroVector (EQ1..EQ6).
const lookup = new Map(`
000000:10 000001:9.9 000010:9.8 000011:9.5 000020:9.5 000021:9.2 000100:10 000101:9.6 000110:9.3 000111:8.7 000120:9.1 000121:8.1
000200:9.3 000201:9 000210:8.9 000211:8 000220:8.1 000221:6.8 001000:9.8 001001:9.5 001010:9.5 001011:9.2 001020:9 001021:8.4
001100:9.3 001101:9.2 001110:8.9 001111:8.1 001120:8.1 001121:6.5 001200:8.8 001201:8 001210:7.8 001211:7 001220:6.9 001221:4.8
002001:9.2 002011:8.2 002021:7.2 002101:7.9 002111:6.9 002121:5 002201:6.9 002211:5.5 002221:2.7 010000:9.9 010001:9.7 010010:9.5
010011:9.2 010020:9.2 010021:8.5 010100:9.5 010101:9.1 010110:9 010111:8.3 010120:8.4 010121:7.1 010200:9.2 010201:8.1 010210:8.2
010211:7.1 010220:7.2 010221:5.3 011000:9.5 011001:9.3 011010:9.2 011011:8.5 011020:8.5 011021:7.3 011100:9.2 011101:8.2 011110:8
011111:7.2 011120:7 011121:5.9 011200:8.4 011201:7 011210:7.1 011211:5.2 011220:5 011221:3 012001:8.6 012011:7.5 012021:5.2
012101:7.1 012111:5.2 012121:2.9 012201:6.3 012211:2.9 012221:1.7 100000:9.8 100001:9.5 100010:9.4 100011:8.7 100020:9.1 100021:8.1
100100:9.4 100101:8.9 100110:8.6 100111:7.4 100120:7.7 100121:6.4 100200:8.7 100201:7.5 100210:7.4 100211:6.3 100220:6.3 100221:4.9
101000:9.4 101001:8.9 101010:8.8 101011:7.7 101020:7.6 101021:6.7 101100:8.6 101101:7.6 101110:7.4 101111:5.8 101120:5.9 101121:5
101200:7.2 101201:5.7 101210:5.7 101211:5.2 101220:5.2 101221:2.5 102001:8.3 102011:7 102021:5.4 102101:6.5 102111:5.8 102121:2.6
102201:5.3 102211:2.1 102221:1.3 110000:9.5 110001:9 110010:8.8 110011:7.6 110020:7.6 110021:7 110100:9 110101:7.7 110110:7.5
110111:6.2 110120:6.1 110121:5.3 110200:7.7 110201:6.6 110210:6.8 110211:5.9 110220:5.2 110221:3 111000:8.9 111001:7.8 111010:7.6
111011:6.7 111020:6.2 111021:5.8 111100:7.4 111101:5.9 111110:5.7 111111:5.7 111120:4.7 111121:2.3 111200:6.1 111201:5.2 111210:5.7
111211:2.9 111220:2.4 111221:1.6 112001:7.1 112011:5.9 112021:3 112101:5.8 112111:2.6 112121:1.5 112201:2.3 112211:1.3 112221:0.6
200000:9.3 200001:8.7 200010:8.6 200011:7.2 200020:7.5 200021:5.8 200100:8.6 200101:7.4 200110:7.4 200111:6.1 200120:5.6 200121:3.4
200200:7 200201:5.4 200210:5.2 200211:4 200220:4 200221:2.2 201000:8.5 201001:7.5 201010:7.4 201011:5.5 201020:6.2 201021:5.1
201100:7.2 201101:5.7 201110:5.5 201111:4.1 201120:4.6 201121:1.9 201200:5.3 201201:3.6 201210:3.4 201211:1.9 201220:1.9 201221:0.8
202001:6.4 202011:5.1 202021:2 202101:4.7 202111:2.1 202121:1.1 202201:2.4 202211:0.9 202221:0.4 210000:8.8 210001:7.5 210010:7.3
210011:5.3 210020:6 210021:5 210100:7.3 210101:5.5 210110:5.9 210111:4 210120:4.1 210121:2 210200:5.4 210201:4.3 210210:4.5
210211:2.2 210220:2 210221:1.1 211000:7.5 211001:5.5 211010:5.8 211011:4.5 211020:4 211021:2.1 211100:6.1 211101:5.1 211110:4.8
211111:1.8 211120:2 211121:0.9 211200:4.6 211201:1.8 211210:1.7 211211:0.7 211220:0.8 211221:0.2 212001:5.3 212011:2.4 212021:1.4
212101:2.4 212111:1.2 212121:0.5 212201:1 212211:0.3 212221:0.1`.trim().split(/\s+/).map(entry => { const [key, value] = entry.split(':'); return [key, Number(value)] as const; }));

// Position of each value; a larger number is less severe.
const levels: Record<string, Record<string, number>> = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 }, PR: { N: 0, L: 0.1, H: 0.2 }, UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 }, AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 }, VI: { H: 0, L: 0.1, N: 0.2 }, VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 }, SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 }, IR: { H: 0, M: 0.1, L: 0.2 }, AR: { H: 0, M: 0.1, L: 0.2 },
};
// The highest severity vectors within each EQ level. EQ3 is keyed by EQ6 as well.
const maxComposed = {
  eq1: [['AV:N/PR:N/UI:N/'], ['AV:A/PR:N/UI:N/', 'AV:N/PR:L/UI:N/', 'AV:N/PR:N/UI:P/'], ['AV:P/PR:N/UI:N/', 'AV:A/PR:L/UI:P/']],
  eq2: [['AC:L/AT:N/'], ['AC:H/AT:N/', 'AC:L/AT:P/']],
  eq3: [
    [['VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/'], ['VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/', 'VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/']],
    [['VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/', 'VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/'],
      ['VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/', 'VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/', 'VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/', 'VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/', 'VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/']],
    [[], ['VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/']],
  ],
  eq4: [['SC:H/SI:S/SA:S/'], ['SC:H/SI:H/SA:H/'], ['SC:L/SI:L/SA:L/']],
  eq5: [['E:A/'], ['E:P/'], ['E:U/']],
};
// Depth of each MacroVector in severity steps (+1).
const maxSeverity = { eq1: [1, 4, 5], eq2: [1, 2], eq3eq6: [[7, 6], [8, 8], [0, 10]], eq4: [6, 5, 4] };

/** Base, threat, and environmental score of a CVSS v4.0 vector. Unknown, duplicated, misordered, or missing base metrics make it malformed. */
export function scoreCvss4(vector: string): CvssScore {
  const text = typeof vector === 'string' ? vector.trim() : '';
  const [prefix, ...parts] = text.split('/');
  if (prefix !== 'CVSS:4.0') return { ok: false, reason: 'CVSS v4.0 の形式ではありません' };
  const values = new Map<string, string>();
  let index = 0;
  for (const part of parts) {
    const [key, value, extra] = part.split(':');
    while (index < metrics.length && metrics[index][0] !== key) {
      if (index < mandatory) return { ok: false, reason: `CVSS の基本値が欠けています（${metrics[index][0]}）` };
      index++;
    }
    if (index >= metrics.length || extra !== undefined || !metrics[index][1].includes(value)) return { ok: false, reason: `CVSS の値が不正です（${part}）` };
    values.set(key, value); index++;
  }
  if (index < mandatory) return { ok: false, reason: `CVSS の基本値が欠けています（${metrics[index][0]}）` };
  // Unset threat and security requirements assume the worst case; modified metrics replace the base value they name.
  const worst: Record<string, string> = { E: 'A', CR: 'H', IR: 'H', AR: 'H' };
  const m = (key: string) => {
    const selected = values.get(key) ?? 'X';
    if (selected === 'X' && worst[key]) return worst[key];
    const modified = values.get(`M${key}`);
    return modified && modified !== 'X' ? modified : selected;
  };
  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(key => m(key) === 'N')) return { ok: true, version: '4.0', score: 0, severity: null, vector: text };

  const eq1 = m('AV') === 'N' && m('PR') === 'N' && m('UI') === 'N' ? 0 : (m('AV') === 'N' || m('PR') === 'N' || m('UI') === 'N') && m('AV') !== 'P' ? 1 : 2;
  const eq2 = m('AC') === 'L' && m('AT') === 'N' ? 0 : 1;
  const eq3 = m('VC') === 'H' && m('VI') === 'H' ? 0 : m('VC') === 'H' || m('VI') === 'H' || m('VA') === 'H' ? 1 : 2;
  const eq4 = m('MSI') === 'S' || m('MSA') === 'S' ? 0 : m('SC') === 'H' || m('SI') === 'H' || m('SA') === 'H' ? 1 : 2;
  const eq5 = { A: 0, P: 1, U: 2 }[m('E') as 'A' | 'P' | 'U'];
  const eq6 = (m('CR') === 'H' && m('VC') === 'H') || (m('IR') === 'H' && m('VI') === 'H') || (m('AR') === 'H' && m('VA') === 'H') ? 0 : 1;
  const macro = (...eq: number[]) => lookup.get(eq.join(''));
  const value = macro(eq1, eq2, eq3, eq4, eq5, eq6)!;

  // Score of the next lower MacroVector in each EQ, or undefined when there is none.
  const lower = [
    macro(eq1 + 1, eq2, eq3, eq4, eq5, eq6),
    macro(eq1, eq2 + 1, eq3, eq4, eq5, eq6),
    eq3 === 0 && eq6 === 0 ? Math.max(macro(eq1, eq2, eq3, eq4, eq5, eq6 + 1) ?? NaN, macro(eq1, eq2, eq3 + 1, eq4, eq5, eq6) ?? NaN)
      : eq3 === 1 && eq6 === 0 ? macro(eq1, eq2, eq3, eq4, eq5, eq6 + 1)
      : eq3 === 2 ? macro(eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1) : macro(eq1, eq2, eq3 + 1, eq4, eq5, eq6),
    macro(eq1, eq2, eq3, eq4 + 1, eq5, eq6),
    macro(eq1, eq2, eq3, eq4, eq5 + 1, eq6),
  ];

  // Distance from the first highest severity vector of this MacroVector that is at least as severe in every metric.
  const pick = (max: string, key: string) => max.slice(max.indexOf(`${key}:`) + key.length + 1).split('/')[0];
  let distance: Record<string, number> = {};
  search: for (const a of maxComposed.eq1[eq1]) for (const b of maxComposed.eq2[eq2]) for (const c of maxComposed.eq3[eq3][eq6])
    for (const d of maxComposed.eq4[eq4]) for (const e of maxComposed.eq5[eq5]) {
      const max = a + b + c + d + e;
      distance = Object.fromEntries(Object.keys(levels).map(key => [key, levels[key][m(key)] - levels[key][pick(max, key)]]));
      if (Object.values(distance).every(x => x >= 0)) break search;
    }
  const current = [
    distance.AV + distance.PR + distance.UI,
    distance.AC + distance.AT,
    distance.VC + distance.VI + distance.VA + distance.CR + distance.IR + distance.AR,
    distance.SC + distance.SI + distance.SA,
    0,
  ];
  const depth = [maxSeverity.eq1[eq1], maxSeverity.eq2[eq2], maxSeverity.eq3eq6[eq3][eq6], maxSeverity.eq4[eq4], 1].map(x => x * 0.1);
  let total = 0, existing = 0;
  lower.forEach((score, i) => {
    const available = value - (score ?? NaN);
    if (Number.isNaN(available)) return;
    existing++; total += available * (current[i] / depth[i]);
  });
  const mean = existing ? total / existing : 0;
  // Round half up, with a small offset so that 1.4499999999999993 (8.6 - 7.15) rounds to 1.5 as intended.
  const score = Math.round((Math.max(0, Math.min(10, value - mean)) + 1e-6) * 10) / 10;
  return { ok: true, version: '4.0', score, severity: ratingOf(score), vector: text };
}
