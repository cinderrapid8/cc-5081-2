import { build } from 'esbuild';
import { mkdir, writeFile, cp, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { STATIC_HTML } from '../src/web/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');

await mkdir(outDir, { recursive: true });
await mkdir(resolve(outDir, 'service'), { recursive: true });

// 面板产物（保留原有能力）。
await build({
  entryPoints: [resolve(root, 'src/web/app.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  outfile: resolve(outDir, 'app.js'),
  logLevel: 'warning',
});
await writeFile(resolve(outDir, 'index.html'), STATIC_HTML, 'utf8');

// 规则服务：打包成单个 ESM 文件，只依赖 Node 内置模块，干净机器无需 npm install 即可运行。
await build({
  entryPoints: [resolve(root, 'src/rule-service/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  packages: 'external',
  outfile: resolve(outDir, 'service/rule-service.mjs'),
  banner: {
    js: '#!/usr/bin/env node\n// 规则服务单文件产物：仅依赖 Node 内置模块，可离线运行。',
  },
  logLevel: 'warning',
});
await chmod(resolve(outDir, 'service/rule-service.mjs'), 0o755);

// 同步规则与部署自检到产物目录，保证 dist 自包含。
await cp(resolve(root, 'rules'), resolve(outDir, 'service/rules'), { recursive: true });
await cp(resolve(root, 'deploy'), resolve(outDir, 'service/deploy'), { recursive: true });

console.log(`built panel + rule-service into ${outDir}`);
