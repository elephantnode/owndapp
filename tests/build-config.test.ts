import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UserConfig } from 'vite';
import config from '../vite.config.js';

const onLog = (config as UserConfig).build!.rolldownOptions!.onLog!;
test('ブラウザ用ライブラリのuse client警告だけを除外し、他の警告を保持する', () => {
  let forwarded = 0;
  const handler = () => { forwarded++; };
  for (const id of ['/repo/node_modules/@radix-ui/react-label/dist/index.mjs', 'C:\\repo\\node_modules\\lucide-react\\dist\\esm\\Icon.mjs', 'node_modules/radix-ui/dist/index.mjs']) {
    onLog('warn', { code: 'MODULE_LEVEL_DIRECTIVE', id, message: 'The semantics of the module level directive "use client" may not be preserved' }, handler);
  }
  assert.equal(forwarded, 0);
  onLog('warn', { code: 'MODULE_LEVEL_DIRECTIVE', id: '/repo/src/App.tsx', message: '"use client"' }, handler);
  onLog('warn', { code: 'MODULE_LEVEL_DIRECTIVE', id: '/repo/node_modules/another-library/index.js', message: '"use client"' }, handler);
  onLog('warn', { code: 'MODULE_LEVEL_DIRECTIVE', id: '/repo/node_modules/lucide-react/index.js', message: '"use server"' }, handler);
  onLog('warn', { code: 'UNRESOLVED_IMPORT', id: '/repo/node_modules/lucide-react/index.js', message: '"use client"' }, handler);
  onLog('info', { code: 'MODULE_LEVEL_DIRECTIVE', id: '/repo/node_modules/lucide-react/index.js', message: '"use client"' }, handler);
  assert.equal(forwarded, 5);
});
