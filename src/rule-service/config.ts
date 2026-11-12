import { readFile, access, readdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

/** 明确的进程退出码，便于编排器区分失败原因。 */
export const EXIT_CODES = {
  OK: 0,
  CONFIG_ERROR: 2,
  RESOURCE_MISSING: 3,
  PROBE_FAILED: 4,
  RESOURCE_LIMIT: 5,
  RUNTIME_ERROR: 10,
} as const;

/** 运行资源上限。既可通过环境变量覆盖，也会在自检里强制生效。 */
export interface ResourceLimits {
  /** 单次请求允许的最长处理毫秒数。 */
  readonly requestTimeoutMs: number;
  /** 请求体最大字节数，防止超大 JSON 耗尽内存。 */
  readonly maxBodyBytes: number;
  /** 启动探针允许的最长毫秒数。 */
  readonly probeTimeoutMs: number;
}

export interface ServerOptions {
  readonly port: number;
  readonly host: string;
  /** 只读规则目录，包含 manifest.json 与各版本子目录。 */
  readonly rulesDir: string;
  /** 状态记录文件（启动/版本切换/关闭都会追加记录）。 */
  readonly stateFile: string;
  /** 启动时锁定的规则版本；缺省取 manifest.activeVersion。 */
  readonly pinnedVersion: string | null;
  readonly limits: ResourceLimits;
  /** 仅做一次部署自检后退出，不常驻。 */
  readonly selfCheckOnly: boolean;
}

export interface RawConfig {
  readonly rulesDir?: unknown;
  readonly stateFile?: unknown;
  readonly port?: unknown;
  readonly host?: unknown;
  readonly pinnedVersion?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly maxBodyBytes?: unknown;
  readonly probeTimeoutMs?: unknown;
  readonly selfCheckOnly?: unknown;
}

const DEFAULTS = {
  port: 4277,
  host: '127.0.0.1',
  requestTimeoutMs: 5000,
  maxBodyBytes: 1_048_576,
  probeTimeoutMs: 15_000,
} as const;

function intFromEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function stringFromEnv(name: string): string | null {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' ? raw : null;
}

/** 统一加载：显式参数 > 环境变量 > 内置默认值，路径统一解析为绝对路径。 */
export function loadOptions(overrides: RawConfig = {}, baseDir = process.cwd()): ServerOptions {
  const rulesDir = resolve(
    baseDir,
    (overrides.rulesDir as string) ?? stringFromEnv('RULES_DIR') ?? 'rules',
  );
  const stateFile = resolve(
    baseDir,
    (overrides.stateFile as string) ?? stringFromEnv('STATE_FILE') ?? 'state/service-state.json',
  );
  const port =
    (Number.isInteger(overrides.port) ? (overrides.port as number) : null) ??
    intFromEnv('PORT') ??
    DEFAULTS.port;
  const host =
    (typeof overrides.host === 'string' && overrides.host) ||
    stringFromEnv('HOST') ||
    DEFAULTS.host;
  const pinnedVersion =
    (typeof overrides.pinnedVersion === 'string' && overrides.pinnedVersion) ||
    stringFromEnv('PINNED_VERSION') ||
    null;

  const requestTimeoutMs =
    (Number.isInteger(overrides.requestTimeoutMs) ? (overrides.requestTimeoutMs as number) : null) ??
    intFromEnv('REQUEST_TIMEOUT_MS') ??
    DEFAULTS.requestTimeoutMs;
  const maxBodyBytes =
    (Number.isInteger(overrides.maxBodyBytes) ? (overrides.maxBodyBytes as number) : null) ??
    intFromEnv('MAX_BODY_BYTES') ??
    DEFAULTS.maxBodyBytes;
  const probeTimeoutMs =
    (Number.isInteger(overrides.probeTimeoutMs) ? (overrides.probeTimeoutMs as number) : null) ??
    intFromEnv('PROBE_TIMEOUT_MS') ??
    DEFAULTS.probeTimeoutMs;

  return {
    port,
    host,
    rulesDir: isAbsolute(rulesDir) ? rulesDir : rulesDir,
    stateFile: isAbsolute(stateFile) ? stateFile : stateFile,
    pinnedVersion,
    selfCheckOnly: overrides.selfCheckOnly === true || process.env.SELF_CHECK_ONLY === '1',
    limits: { requestTimeoutMs, maxBodyBytes, probeTimeoutMs },
  };
}

export interface RuleManifest {
  readonly activeVersion: string;
  readonly versions: readonly { readonly version: string; readonly file: string; readonly summary: string }[];
}

export class ResourceMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceMissingError';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读取并校验清单。清单缺失是「启动资源缺失」，与规则语义失败区分开。 */
export async function loadManifest(rulesDir: string): Promise<RuleManifest> {
  const manifestPath = resolve(rulesDir, 'manifest.json');
  if (!(await exists(manifestPath))) {
    throw new ResourceMissingError(`规则清单缺失：${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new ResourceMissingError(`规则清单无法解析：${manifestPath}（${(error as Error).message}）`);
  }
  const record = parsed as Record<string, unknown>;
  if (!record || typeof record.activeVersion !== 'string' || !Array.isArray(record.versions)) {
    throw new ResourceMissingError(`规则清单结构非法：${manifestPath}`);
  }
  const versions = record.versions.map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      version: String(item.version),
      file: String(item.file),
      summary: typeof item.summary === 'string' ? item.summary : '',
    };
  });
  return { activeVersion: record.activeVersion, versions };
}

/** 读取某个版本的原始规则 JSON；文件缺失按启动资源缺失处理。 */
export async function loadRuleDocument(rulesDir: string, file: string): Promise<unknown> {
  const path = resolve(rulesDir, file);
  if (!(await exists(path))) {
    throw new ResourceMissingError(`规则文件缺失：${path}`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ResourceMissingError(`规则文件无法解析：${path}（${(error as Error).message}）`);
  }
}

export async function listRuleDir(rulesDir: string): Promise<string[]> {
  if (!(await exists(rulesDir))) {
    throw new ResourceMissingError(`规则目录缺失或不可读：${rulesDir}`);
  }
  return readdir(rulesDir);
}
