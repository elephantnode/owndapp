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

/** Orders versions the way the ecosystem does: PEP 440 for PyPI, semver for npm and Composer. */
export function compareVersions(ecosystem: Ecosystem | undefined, a: string, b: string) {
  return ecosystem === 'PyPI' ? comparePython(a, b) : compareSemver(a, b);
}
