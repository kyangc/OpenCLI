import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8'));
const compatRange: string = pkg.opencli?.compatRange ?? '>=0.0.0';
const serviceWorkerPath: unknown = manifest.background?.service_worker;

if (typeof serviceWorkerPath !== 'string'
  || !serviceWorkerPath.startsWith('dist/')
  || serviceWorkerPath.slice('dist/'.length).includes('/')) {
  throw new Error('Extension service worker must be a file directly under dist/.');
}

const serviceWorkerFileName = serviceWorkerPath.slice('dist/'.length);

export default defineConfig({
  define: {
    __OPENCLI_COMPAT_RANGE__: JSON.stringify(compatRange),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/background.ts'),
      output: {
        entryFileNames: serviceWorkerFileName,
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false,
  },
});
