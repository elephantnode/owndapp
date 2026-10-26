import { createHash } from 'node:crypto';
import type { Dependency, DependencySnapshot } from '../shared/types.js';

// Ordering and read timestamps do not change what was inspected. File coverage,
// hashes, read failures and every saved dependency field do.
export function dependencyContentId(snapshot: DependencySnapshot, dependencies: Dependency[]) {
  const files = snapshot.files.map(file => JSON.stringify({
    path: file.path, format: file.format ?? null, lockfileVersion: file.lockfileVersion,
    status: file.status, hashes: Object.entries(file.hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  })).sort();
  const rows = dependencies.map(d => JSON.stringify([d.ecosystem ?? 'npm', d.name, d.version, d.requested,
    d.direct, d.scope, d.source, d.file, d.component])).sort();
  return createHash('sha256').update(JSON.stringify({ status: snapshot.status, files, rows })).digest('hex');
}
