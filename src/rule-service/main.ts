import { loadManifest, loadOptions, loadRuleDocument, ResourceMissingError, EXIT_CODES, type ServerOptions } from './config.js';
import { RuleVersionManager, summarizeIssues } from './version-manager.js';
import { StateJournal } from './state-journal.js';
import { runStartupProbe } from './probe.js';
import { startHttpServer } from './http-server.js';

/**
 * 规则服务入口。启动顺序固定：
 * 加载运行参数 → 读清单 → 读活动规则 → 隔离引导（拒绝空属性表）→
 * 启动探针（真实装卸两组配置并核对派生数值）→ 起 HTTP → 写状态记录。
 * 每一类失败都有独立退出码，编排器可以据此判断能否重启/告警。
 */
async function main(): Promise<number> {
  const options = loadOptions();
  const journal = await StateJournal.open(options.stateFile);

  let manifest;
  try {
    manifest = await loadManifest(options.rulesDir);
  } catch (error) {
    if (error instanceof ResourceMissingError) {
      console.error(`[rule-service] 启动资源缺失：${error.message}`);
      await journal.append('startup', {
        activeVersion: null,
        revision: null,
        detail: `启动失败-资源缺失：${error.message}`,
      });
      return EXIT_CODES.RESOURCE_MISSING;
    }
    throw error;
  }

  const wantedVersion = options.pinnedVersion ?? manifest.activeVersion;
  const entry = manifest.versions.find((item) => item.version === wantedVersion);
  if (!entry) {
    console.error(`[rule-service] 清单中找不到版本 ${wantedVersion}`);
    await journal.append('startup', {
      activeVersion: null,
      revision: null,
      detail: `启动失败-未知版本：${wantedVersion}`,
    });
    return EXIT_CODES.CONFIG_ERROR;
  }

  let document: unknown;
  try {
    document = await loadRuleDocument(options.rulesDir, entry.file);
  } catch (error) {
    console.error(`[rule-service] ${(error as Error).message}`);
    await journal.append('startup', {
      activeVersion: null,
      revision: null,
      detail: `启动失败-规则资源缺失：${(error as Error).message}`,
    });
    return EXIT_CODES.RESOURCE_MISSING;
  }

  const boot = RuleVersionManager.bootstrap(document);
  if (!boot.manager) {
    console.error(`[rule-service] 规则版本 ${wantedVersion} 引导失败：${summarizeIssues(boot.report.issues)}`);
    await journal.append('startup', {
      activeVersion: null,
      revision: null,
      detail: `启动失败-规则校验未通过：${summarizeIssues(boot.report.issues)}`,
      issues: boot.report.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    });
    return EXIT_CODES.CONFIG_ERROR;
  }
  const manager = boot.manager;

  const probeReport = runStartupProbe(manager.attributeService, manager.activeBundle);
  await journal.append('probe', {
    activeVersion: manager.activeVersion,
    revision: manager.attributeService.getState().revision,
    detail: probeReport.passed
      ? `启动探针通过（${probeReport.checks.length} 项核对全部成功）`
      : `启动探针失败：${probeReport.checks.filter((c) => !c.passed).map((c) => c.name).join('、')}`,
  });
  if (!probeReport.passed) {
    console.error('[rule-service] 启动探针失败，拒绝上线：');
    for (const failed of probeReport.checks.filter((c) => !c.passed)) {
      console.error(`  - ${failed.name}: 期望 ${JSON.stringify(failed.expected)} 实际 ${JSON.stringify(failed.actual)}（${failed.detail}）`);
    }
    return EXIT_CODES.PROBE_FAILED;
  }

  await journal.append('version-adopted', {
    activeVersion: manager.activeVersion,
    revision: manager.attributeService.getState().revision,
    detail: `启动采用规则版本 ${manager.activeVersion}（${manager.activeBundle.label}）`,
  });

  if (options.selfCheckOnly) {
    console.log(JSON.stringify({ selfCheck: 'passed', activeVersion: manager.activeVersion, probeChecks: probeReport.checks.length }, null, 2));
    return EXIT_CODES.OK;
  }

  const started = await startHttpServer({ manager, journal, options });
  await journal.append('startup', {
    activeVersion: manager.activeVersion,
    revision: manager.attributeService.getState().revision,
    detail: `服务监听 ${options.host}:${started.port}，资源上限 ${JSON.stringify(options.limits)}`,
  });
  console.log(
    `[rule-service] version=${manager.activeVersion} listening=http://${options.host}:${started.port} ` +
      `timeoutMs=${options.limits.requestTimeoutMs} maxBodyBytes=${options.limits.maxBodyBytes}`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await started.close();
      await journal.append('shutdown', {
        activeVersion: manager.activeVersion,
        revision: manager.attributeService.getState().revision,
        detail: `收到 ${signal}，进程停止，下线时活动版本 ${manager.activeVersion}`,
      });
    } finally {
      process.exit(EXIT_CODES.OK);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    console.error('[rule-service] 未捕获异常：', error);
    void journal
      .append('shutdown', {
        activeVersion: manager.activeVersion,
        revision: null,
        detail: `未捕获异常终止：${error.message}`,
      })
      .finally(() => process.exit(EXIT_CODES.RUNTIME_ERROR));
  });

  return new Promise<number>(() => {
    /* 常驻直到收到信号 */
  });
}

main()
  .then((code) => {
    if (code !== EXIT_CODES.OK) process.exit(code);
  })
  .catch((error: Error) => {
    console.error('[rule-service] 致命错误：', error);
    process.exit(EXIT_CODES.RUNTIME_ERROR);
  });

export type { ServerOptions };
