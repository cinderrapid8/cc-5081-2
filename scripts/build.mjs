import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { STATIC_HTML } from '../src/web/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/web/app.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  outfile: resolve(outDir, 'app.js'),
  logLevel: 'warning',
});

await writeFile(resolve(outDir, 'index.html'), STATIC_HTML, 'utf8');

console.log(`built ${outDir}`);
