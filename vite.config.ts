import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', strictPort: true, fs: { strict: true } },
  build: {
    outDir: 'dist',
    license: { fileName: 'third-party-licenses.md' },
    rolldownOptions: {
      onLog(level, log, handler) {
        // This app is browser-only, without React Server Components. These libraries' client boundary markers are not needed here.
        // Keep every other directive, library and warning visible, including application-code warnings.
        const source = (log.id ?? log.loc?.file ?? log.message).replaceAll('\\', '/');
        if (level === 'warn' && log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('"use client"') &&
          /(?:^|\/)node_modules\/(?:@radix-ui\/|radix-ui\/|lucide-react\/)/.test(source)) return;
        handler(level, log);
      },
      output: { codeSplitting: { groups: [{ name: 'vendor', test: /[\\/]node_modules[\\/]/ }] } },
    },
  },
});
