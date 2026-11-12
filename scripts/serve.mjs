import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const port = Number(process.env.PORT ?? 4173);

const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const entry = FILES.get(path);
  if (!entry) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  try {
    const body = await readFile(resolve(dist, entry[0]), 'utf8');
    response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('build missing: run npm run build');
  }
});

server.listen(port, () => {
  console.log(`serving http://localhost:${port}`);
});
