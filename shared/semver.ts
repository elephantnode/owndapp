import type { Ecosystem } from './types.js';

// Minimal semver ordering for choosing a fixed version: numeric core, then prerelease before release.
// The core may have more than three parts, as Composer versions sometimes do (1.2.3.4).
function parts(version: string) {
  const [core, pre] = version.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
  return { core: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
}
export function compareSemver(a: string, b: string) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(3, x.core.length, y.core.length); i++) if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) - (y.core[i] || 0);
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1; if (q === undefined) return 1;
    const m = /^\d+$/.test(p), n = /^\d+$/.test(q);
    if (m && n && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (m !== n) return m ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// PEP 440 (Python): epoch, release, then dev < pre (a, b, rc) < final < post. Local versions (+...) are ignored.
const pep440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+.*)?$/i;
const preRank: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };
function pythonKey(version: string) {
  const m = version.trim().match(pep440);
  if (!m) return null;
  const [, epoch, release, pre, preN, postDash, postN, devN] = m;
  const post = postDash ?? postN; const dev = devN ?? (/dev/i.test(version) ? '' : undefined);
  const num = (value: string | undefined) => Number(value || 0);
  return [num(epoch), release.split('.').map(Number),
    pre ? [preRank[pre.toLowerCase()], num(preN)] : dev !== undefined && post === undefined ? [-1, 0] : [3, 0],
    post !== undefined ? num(post) : -1, dev !== undefined ? num(dev) : Infinity] as const;
}
function comparePython(a: string, b: string) {
  const x = pythonKey(a), y = pythonKey(b);
  if (!x || !y) return compareSemver(a, b);
  if (x[0] !== y[0]) return x[0] - y[0];
  for (let i = 0; i < Math.max(x[1].length, y[1].length); i++) if ((x[1][i] || 0) !== (y[1][i] || 0)) return (x[1][i] || 0) - (y[1][i] || 0);
  return x[2][0] - y[2][0] || x[2][1] - y[2][1] || x[3] - y[3] || (x[4] === y[4] ? 0 : x[4] < y[4] ? -1 : 1);
}

// RubyGems (Gem::Version): numbers and letters are separate segments, missing ones count as 0, and a letter
// sorts before any number, so 1.0.0.rc1 comes before 1.0.0.
function compareRubyGems(a: string, b: string) {
  const segments = (v: string) => (v.match(/[0-9]+|[a-z]+/gi) ?? []).map(s => /^\d/.test(s) ? Number(s) : s);
  const x = segments(a), y = segments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0, q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === 'string' && typeof q === 'string') return p < q ? -1 : 1;
    if (typeof p === 'string') return -1;
    if (typeof q === 'string') return 1;
    return p - q;
  }
  return 0;
}

// Maven (ComparableVersion): items split at . and -, and where digits meet letters; - and a letter-digit change open a
// sublist. Known qualifiers order alpha < beta < milestone < rc < snapshot < release < sp; others follow, by name.
type MavenItem = number | string | MavenItem[];
const qualifiers = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const qualifierAliases: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };
function qualifierKey(q: string) {
  const index = qualifiers.indexOf(qualifierAliases[q] ?? q);
  return index >= 0 ? String(index) : `${qualifiers.length}-${q}`;
}
// Trailing zeros and release qualifiers carry no meaning: 1.0 and 1 and 1-ga are the same version.
function trimMaven(list: MavenItem[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item === 0 || (typeof item === 'string' && qualifierKey(item) === '5') || (Array.isArray(item) && !item.length)) list.splice(i, 1);
    else if (!Array.isArray(item)) break;
  }
  return list;
}
function parseMaven(version: string): MavenItem[] {
  const root: MavenItem[] = []; let list = root; const lists = [root];
  const v = version.toLowerCase(); let start = 0; let digit = false;
  const push = (end: number, followedByDigit = false) => {
    const token = v.slice(start, end);
    if (!token) { list.push(0); return; }
    if (digit) { list.push(Number(token)); return; }
    // a1, b2, m3 are short for alpha-1, beta-2, milestone-3.
    list.push(followedByDigit && token.length === 1 ? { a: 'alpha', b: 'beta', m: 'milestone' }[token] ?? token : token);
  };
  const sublist = () => { const next: MavenItem[] = []; list.push(next); list = next; lists.push(next); };
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '.') { push(i); start = i + 1; }
    else if (c === '-') { push(i); start = i + 1; sublist(); }
    else if (c >= '0' && c <= '9') { if (!digit && i > start) { push(i, true); start = i; sublist(); } digit = true; }
    else { if (digit && i > start) { push(i); start = i; sublist(); } digit = false; }
  }
  if (v.length > start) push(v.length);
  for (const l of lists.reverse()) trimMaven(l);
  return root;
}
function compareMavenItem(p: MavenItem | undefined, q: MavenItem | undefined): number {
  if (p === undefined && q === undefined) return 0;
  if (p === undefined) return -compareMavenItem(q, undefined);
  if (typeof p === 'number') return q === undefined ? (p === 0 ? 0 : 1) : typeof q === 'number' ? p - q : 1;
  if (typeof p === 'string') {
    if (typeof q === 'number' || Array.isArray(q)) return -1;
    const x = qualifierKey(p), y = qualifierKey(q ?? '');
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (q === undefined) return p.length ? compareMavenItem(p[0], undefined) : 0;
  if (typeof q === 'number') return -1;
  if (typeof q === 'string') return 1;
  for (let i = 0; i < Math.max(p.length, q.length); i++) { const r = compareMavenItem(p[i], q[i]); if (r) return r; }
  return 0;
}
const compareMaven = (a: string, b: string) => compareMavenItem(parseMaven(a), parseMaven(b));

/** Orders versions the way the ecosystem does: PEP 440 for PyPI, Gem::Version for RubyGems, ComparableVersion for Maven, semver otherwise. */
export function compareVersions(ecosystem: Ecosystem | undefined, a: string, b: string) {
  return ecosystem === 'PyPI' ? comparePython(a, b) : ecosystem === 'RubyGems' ? compareRubyGems(a, b) : ecosystem === 'Maven' ? compareMaven(a, b) : compareSemver(a, b);
}
