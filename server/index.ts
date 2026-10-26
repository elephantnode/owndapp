import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Store } from './store.js';
import { createApi } from './api.js';
import { fixtureClient } from './osv.js';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const port = Number(process.env.OWNDAPP_PORT || 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('OWNDAPP_PORTを確認してください');
const dataDir = resolve(process.env.OWNDAPP_DATA_DIR || '.owndapp');
const store = new Store(resolve(dataDir, 'catalog.sqlite'));
// Browser tests never touch Finder: the folder dialog returns a fixed folder and opening a folder does nothing.
const testFolder = process.env.OWNDAPP_TEST_PICK_FOLDER;
// Likewise the application chooser returns OWNDAPP_TEST_PICK_APP, and opening with an application does nothing.
const testApp = process.env.OWNDAPP_TEST_PICK_APP;
const api = createApi(store, port, testFolder ? async () => testFolder : undefined, testFolder ? async () => {} : undefined,
  testFolder ? { pickApp: async () => testApp || null, openApp: async () => {},
    // OSV answers from OWNDAPP_TEST_OSV (a JSON file of records keyed by "name@version"), so browser tests stay offline.
    osv: fixtureClient(process.env.OWNDAPP_TEST_OSV ? JSON.parse(readFileSync(process.env.OWNDAPP_TEST_OSV, 'utf8')) : {}) } : {});
const production = process.argv.includes('--production');
const listener = getRequestListener(api.fetch);
const server = createServer();
let closeVite: (() => Promise<void>) | undefined;
if (production) {
  const frontend = new Hono();
  frontend.use('*', serveStatic({ root: './dist' }));
  frontend.get('*', serveStatic({ path: './dist/index.html' }));
  const handleFrontend = getRequestListener(frontend.fetch);
  server.on('request', (req, res) => {
    if (req.url?.startsWith('/api/')) void listener(req, res); else void handleFrontend(req, res);
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' });
  closeVite = () => vite.close();
  server.on('request', (req, res) => {
    if (req.url?.startsWith('/api/')) void listener(req, res); else vite.middlewares(req, res);
  });
}
server.listen(port, '127.0.0.1', () => console.log(`owndapp: http://127.0.0.1:${port}`));
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await api.shutdownScans(); await closeVite?.(); } finally { store.close(); }
}
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE'
    ? `ポート${port}は使用中です。すでにowndappを起動していないか確認してください。別のポートで起動する場合は OWNDAPP_PORT=4311 npm start のように指定できます。`
    : error.message);
  process.exitCode = 1;
  void cleanup();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => { void cleanup().finally(() => process.exit(0)); }); });
}
