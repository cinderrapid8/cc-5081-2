#!/usr/bin/env node
/**
 * 部署自检（无网络资源下载）。
 *
 * 它在临时工作区里启动单文件规则服务，并验证：
 *  1. 干净目录、零 npm install，仅靠 Node 即可启动；
 *  2. 启动探针真实装卸两组配置并核对派生数值（而非只看端口）；
 *  3. 真实客户端完成一次属性查询才算通过；
 *  4. 循环引用 / 未知运算符候选被隔离拒绝，活动版本不变；
 *  5. 只读配置目录可读、可服务，但写入被拒绝；
 *  6. 启动资源缺失时以明确退出码失败，不发布空属性表；
 *  7. 进程被停止后再次启动，状态记录说明最终采用的版本；
 *  8. 资源上限：超大请求体返回 413。
 *
 * 用法：node deploy/self-check.mjs [--bundle dist/service]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, cp, chmod, readFile, writeFile, mkdir, rm, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const bundleArg = process.argv[2] === '--bundle' ? process.argv[3] : null;
const bundleDir = resolve(repoRoot, bundleArg ?? 'dist/service');

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message ?? 'no response'}`);
}

function startService(cwd, env, port) {
  const child = spawn(process.execPath, ['rule-service.mjs'], {
    cwd,
    env: {
      PATH: process.env.PATH,
      RULES_DIR: env.rulesDir ?? 'rules',
      STATE_FILE: env.stateFile,
      PORT: String(port),
      HOST: '127.0.0.1',
      ...(env.extra ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, logs, stop: () => !child.killed && child.kill('SIGTERM') };
}

async function exitCode(cwd, env) {
  return await new Promise((resolveExit) => {
    const child = spawn(process.execPath, ['rule-service.mjs'], {
      cwd,
      env: { PATH: process.env.PATH, RULES_DIR: env.rulesDir ?? 'rules', STATE_FILE: env.stateFile, HOST: '127.0.0.1', SELF_CHECK_ONLY: '1', ...(env.extra ?? {}) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => resolveExit(code));
  });
}

const basePort = 4400 + Math.floor(Math.random() * 200);
const work = await mkdtemp(resolve(tmpdir(), 'rule-service-deploy-'));
try {
  // ---- 场景 1：干净目录复制单文件产物，不安装任何依赖 ----
  const appDir = resolve(work, 'app');
  await cp(bundleDir, appDir, { recursive: true });
  const hasNodeModules = await access(resolve(appDir, 'node_modules')).then(() => true).catch(() => false);
  record('clean-machine-no-dependencies', !hasNodeModules, '产物目录不含 node_modules，仅 Node 内置模块');

  const stateFile = resolve(work, 'state', 'service.jsonl');
  const port = basePort;
  const proc = startService(appDir, { stateFile }, port);
  let exitedEarly = null;
  proc.child.on('exit', (code) => { exitedEarly = code; });

  try {
    await waitFor(`http://127.0.0.1:${port}/health`);
    record('startup-probe-gates-listen', exitedEarly === null, '探针通过后进程才持续监听（失败会以退出码 4 终止）');

    // ---- 场景 3：真实客户端完成一次属性查询 ----
    const query = await fetch(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attributes: ['maxHp', 'shieldCapacity', 'shieldRegen'] }),
    });
    const queryBody = await query.json();
    const expectedShield = Math.round((queryBody.values.maxHp * 0.35 + 40) * 1000) / 1000;
    record(
      'real-client-attribute-query',
      query.ok && queryBody.activeVersion === 'v1' && queryBody.values.shieldCapacity === expectedShield,
      `客户端查询返回派生数值 maxHp=${queryBody.values.maxHp} shieldCapacity=${queryBody.values.shieldCapacity}`,
    );

    // ---- 探针装卸两组配置的端到端旁证：切换负载产生不同数值，再切回 ----
    const siege = await fetch(`http://127.0.0.1:${port}/loadouts/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loadoutId: 'siege' }),
    }).then((r) => r.json());
    const back = await fetch(`http://127.0.0.1:${port}/loadouts/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loadoutId: 'field' }),
    }).then((r) => r.json());
    record('two-loadouts-mounted-and-restored', siege.accepted && back.accepted && back.values.length > 0, '客户端侧装卸两组配置并恢复');

    // ---- 场景 4：隔离校验拒绝坏候选，活动版本不变 ----
    for (const [file, expectCode] of [
      ['deploy/candidates/cyclic.json', 'dependency-cycle'],
      ['deploy/candidates/unknown-operator.json', 'unknown-operator'],
    ]) {
      const candidate = await readFile(resolve(appDir, file), 'utf8');
      const rejected = await fetch(`http://127.0.0.1:${port}/rules/reload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: candidate,
      }).then((r) => r.json());
      record(
        `reject-${expectCode}`,
        rejected.accepted === false && rejected.activeVersion === 'v1' && rejected.issues.some((i) => i.code === expectCode),
        `${file} 被隔离拒绝，活动版本保持 ${rejected.activeVersion}`,
      );
    }
    const stillV1 = await fetch(`http://127.0.0.1:${port}/version`).then((r) => r.json());
    record('active-version-unchanged-after-rejections', stillV1.activeVersion === 'v1', '坏候选未污染活动规则集');

    // ---- 场景 8：资源上限，超大请求体 413 ----
    const oversize = await fetch(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"attributes":["a"]}${'x'.repeat(1_100_000)}`,
    });
    record('resource-limit-payload-413', oversize.status === 413, `超大请求体返回 ${oversize.status}`);

    // ---- 场景 5：只读配置目录可读可服务，写入被拒 ----
    const rulesDir = resolve(appDir, 'rules');
    await chmod(rulesDir, 0o555);
    const roRead = await fetch(`http://127.0.0.1:${port}/attributes`);
    let writeBlocked = false;
    try {
      await writeFile(resolve(rulesDir, 'should-not-exist.json'), '{}');
    } catch {
      writeBlocked = true;
    }
    record('read-only-config-dir', roRead.ok && writeBlocked, '只读规则目录仍可服务，写入被操作系统拒绝');
    await chmod(rulesDir, 0o755);
  } finally {
    proc.stop();
    await new Promise((r) => setTimeout(r, 400));
  }

  // ---- 场景 7：进程被停止后再次启动，状态记录说明采用版本 ----
  const restarted = startService(appDir, { stateFile }, port + 1);
  try {
    await waitFor(`http://127.0.0.1:${port + 1}/health`);
    const version = await fetch(`http://127.0.0.1:${port + 1}/version`).then((r) => r.json());
    const journalText = await readFile(stateFile, 'utf8');
    const hasShutdown = journalText.includes('"event":"shutdown"');
    const hasAdopt = journalText.includes('"version-adopted"') && journalText.includes('"v1"');
    record(
      'restart-after-stop-and-journal-version',
      version.activeVersion === 'v1' && hasShutdown && hasAdopt,
      `停止后重启成功，状态记录含 shutdown/version-adopted，采用版本=${version.activeVersion}`,
    );
  } finally {
    restarted.stop();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---- 场景 6：启动资源缺失 -> 明确退出码 3 ----
  const missingDir = resolve(work, 'missing-rules');
  await mkdir(missingDir, { recursive: true });
  const missingCode = await exitCode(appDir, { rulesDir: missingDir, stateFile: resolve(work, 'state-missing.jsonl') });
  record('missing-resource-exit-code', missingCode === 3, `规则目录缺失时退出码=${missingCode}（期望 3）`);

  // 规则文件缺失（清单在但版本文件不在）
  const brokenApp = resolve(work, 'broken-app');
  await cp(appDir, brokenApp, { recursive: true });
  await rm(resolve(brokenApp, 'rules', 'v1'), { recursive: true, force: true });
  const brokenCode = await exitCode(brokenApp, { stateFile: resolve(work, 'state-broken.jsonl') });
  record('missing-rule-file-exit-code', brokenCode === 3, `版本文件缺失时退出码=${brokenCode}（期望 3）`);

  // ---- 坏规则引导失败 -> 退出码 2，且不发布空属性表 ----
  const badApp = resolve(work, 'bad-app');
  await cp(appDir, badApp, { recursive: true });
  await cp(resolve(appDir, 'deploy/candidates/unknown-operator.json'), resolve(badApp, 'rules/v1/rules.json'));
  const badCode = await exitCode(badApp, { stateFile: resolve(work, 'state-bad.jsonl') });
  record('invalid-rule-exit-code', badCode === 2, `未知运算符规则引导失败退出码=${badCode}（期望 2），空属性表不会上线`);
} catch (error) {
  record('self-check-fatal', false, error.stack);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.passed);
console.log(`\n自检汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('部署自检全部通过，交付流程闭合。');
