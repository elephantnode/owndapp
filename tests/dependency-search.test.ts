import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import type { Dependency } from '../shared/types.js';

test('Brotliは部分一致で派生名を探せ、完全一致・版指定・記号の文字通りの検索もできる', () => {
  const store = new Store(':memory:');
  try {
    const { projectIds: [id] } = store.import('search', [{ id: 'fixture', name: 'fixture', path: '/fixture', technologies: [], components: [], evidence: [], fingerprint: 'x', registered: false }]);
    const dependencies: Dependency[] = ['brotli', 'brotli-wasm', '@scope/brotli', 'brotli_extra', 'brotli%literal', 'other'].map(name => ({ ecosystem: 'npm', name, version: name === 'brotli' ? '1.0.0' : '2.0.0', requested: null, direct: false, scope: 'prod', source: 'registry', file: 'package-lock.json', component: '' }));
    store.saveDependencies({ projectId: id, readAt: '2026-10-26', status: 'complete', files: [], total: dependencies.length, direct: 0 }, dependencies);
    const names = (query: string, version?: string, match: 'contains' | 'exact' = 'contains') => (store.searchDependencies(query, version, match).get(id) ?? []).map(d => d.name).sort();
    assert.deepEqual(names('Brotli'), dependencies.filter(d => d.name !== 'other').map(d => d.name).sort());
    assert.deepEqual(names('Brotli', undefined, 'exact'), ['brotli']);
    assert.deepEqual(names('Brotli', '1.0.0'), ['brotli']);
    assert.deepEqual(names('brotli_'), ['brotli_extra']);
    assert.deepEqual(names('brotli%'), ['brotli%literal']);
  } finally { store.close(); }
});
