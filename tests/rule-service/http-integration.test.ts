import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const bundle = resolve(repoRoot, 'dist/service');

let work: string;
let child: ChildProcess;
let port: number;
let base: string;

before(async () => {
  work = await mkdtemp(resolve(tmpdir(), 'rule-service-http-'));
  const app = resolve(work, 'app');
  await cp(bundle, app, { recursive: true });
  port = 4600 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['rule-service.mjs'], {
    cwd: app,
    env: {
      PATH: process.env.PATH,
      RULES_DIR: 'rules',
      STATE_FILE: resolve(work, 'state.jsonl'),
      PORT: String(port),
      HOST: '127.0.0.1',
      MAX_BODY_BYTES: '65536',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {
      /* 等待监听 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await rm(work, { recursive: true, force: true }).catch(() => {});
});

describe('HTTP 规则服务端到端', () => {
  it('健康检查返回活动版本与属性表', async () => {
    const body = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.activeVersion, 'v1');
    assert.ok(body.attributes.length >= 7);
  });

  it('真实客户端完成属性查询，派生值符合换算公式', async () => {
    const body = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attributes: ['maxHp', 'shieldCapacity'] }),
    }).then((r) => r.json());
    const expected = Math.round((body.values.maxHp * 0.35 + 40) * 1000) / 1000;
    assert.equal(body.values.shieldCapacity, expected);
  });

  it('未知属性返回 404 而非空表', async () => {
    const response = await fetch(`${base}/attributes/nope`);
    assert.equal(response.status, 404);
  });

  it('热替换到 v2 后采用新版本，再拒绝坏候选且回退保持', async () => {
    const v2 = JSON.parse(await readFile(resolve(bundle, 'rules/v2/rules.json'), 'utf8'));
    const adopted = await fetch(`${base}/rules/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(v2),
    }).then((r) => r.json());
    assert.equal(adopted.accepted, true);
    assert.equal(adopted.activeVersion, 'v2');

    const cyclic = JSON.parse(await readFile(resolve(bundle, 'deploy/candidates/cyclic.json'), 'utf8'));
    const rejected = await fetch(`${base}/rules/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cyclic),
    }).then((r) => r.json());
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.activeVersion, 'v2');
    assert.ok(rejected.issues.some((i: { code: string }) => i.code === 'dependency-cycle'));
  });

  it('请求体超上限返回 413', async () => {
    const response = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"attributes":["a"]}${'x'.repeat(70000)}`,
    });
    assert.equal(response.status, 413);
  });

  it('状态记录说明采用了哪个版本', async () => {
    const text = await readFile(resolve(work, 'state.jsonl'), 'utf8');
    assert.ok(text.includes('"version-adopted"'));
    assert.ok(text.includes('"v2"'));
    assert.ok(text.includes('"version-rejected"'));
  });
});
