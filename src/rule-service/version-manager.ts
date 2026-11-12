import { AttributeService, ConfigurationRejectedError } from '../core/service.js';
import type { AttributeCatalog, ValidationIssue, ValidationReport } from '../core/types.js';
import { finishReport } from '../core/validate.js';
import { parseRuleBundle, toConfigurationCandidate, type RuleBundle } from './rule-bundle.js';

export interface VersionAdoption {
  readonly ok: boolean;
  readonly version: string | null;
  readonly revision: number;
  readonly report: ValidationReport;
}

/**
 * 规则版本管理器。
 *
 * 关键不变量：任何候选规则都先在隔离的临时 AttributeService 里完整构造+整图校验，
 * 只有校验通过、且能成功求值出非空属性表，才允许提升为活动版本。
 * 循环引用 / 未知运算符 / 缺失依赖都会让候选失败，活动角色继续使用已确认版本。
 */
export class RuleVersionManager {
  private service: AttributeService;
  private bundle: RuleBundle;
  private revisionBase = 0;

  private constructor(initial: { service: AttributeService; bundle: RuleBundle }) {
    this.service = initial.service;
    this.bundle = initial.bundle;
  }

  /** 引导首个版本。失败时 manager 为 null，由入口决定退出码（绝不发布空属性表）。 */
  static bootstrap(document: unknown): { manager: RuleVersionManager | null; report: ValidationReport } {
    const parsed = parseRuleBundle(document);
    if (!parsed.ok || !parsed.bundle) {
      return {
        manager: null,
        report: finishReport(parsed.issues),
      };
    }
    const bundle = parsed.bundle;
    try {
      const service = buildService(bundle);
      // 引导阶段再做一次求值冒烟，确保不是空属性表。
      assertNonEmpty(service, bundle.version);
      return { manager: new RuleVersionManager({ service, bundle }), report: finishReport([]) };
    } catch (error) {
      if (error instanceof ConfigurationRejectedError) {
        return { manager: null, report: error.report };
      }
      return {
        manager: null,
        report: finishReport([
          {
            code: 'malformed-document',
            message: `版本 ${bundle.version} 引导求值失败：${(error as Error).message}`,
          },
        ]),
      };
    }
  }

  get activeVersion(): string {
    return this.bundle.version;
  }

  get activeBundle(): RuleBundle {
    return this.bundle;
  }

  get attributeService(): AttributeService {
    return this.service;
  }

  /**
   * 隔离校验候选版本：在临时实例上构造，不触碰当前活动服务。
   * 返回结构化报告，调用方据此决定是否 adopt。
   */
  validateCandidate(document: unknown): { ok: boolean; bundle: RuleBundle | null; report: ValidationReport } {
    const parsed = parseRuleBundle(document);
    if (!parsed.ok || !parsed.bundle) {
      return { ok: false, bundle: null, report: finishReport(parsed.issues) };
    }
    const candidate = parsed.bundle;
    const report = this.probe(candidate);
    return { ok: report.ok, bundle: candidate, report };
  }

  /**
   * 采用候选版本。先隔离校验，通过后再替换内部服务；
   * 失败时当前服务、版本号、revision 全部保持不变。
   */
  adopt(document: unknown): VersionAdoption {
    const currentRevision = this.service.getState().revision;
    const checked = this.validateCandidate(document);
    if (!checked.ok || !checked.bundle) {
      return {
        ok: false,
        version: this.bundle.version,
        revision: currentRevision,
        report: checked.report,
      };
    }
    const nextService = buildService(checked.bundle);
    assertNonEmpty(nextService, checked.bundle.version);
    // 替换是最后一步且为单纯引用切换，活动角色从这里起使用新规则集。
    this.service = nextService;
    this.bundle = checked.bundle;
    this.revisionBase += 1;
    return {
      ok: true,
      version: checked.bundle.version,
      revision: nextService.getState().revision + this.revisionBase,
      report: finishReport([]),
    };
  }

  /** 在不影响活动服务的前提下，对候选包做整图校验 + 求值冒烟。 */
  private probe(bundle: RuleBundle): ValidationReport {
    try {
      const candidate = buildService(bundle);
      assertNonEmpty(candidate, bundle.version);
      return finishReport([]);
    } catch (error) {
      if (error instanceof ConfigurationRejectedError) {
        return error.report;
      }
      return finishReport([
        {
          code: 'malformed-document',
          message: `候选版本 ${bundle.version} 隔离求值失败：${(error as Error).message}`,
        },
      ]);
    }
  }
}

function buildService(bundle: RuleBundle): AttributeService {
  const catalog: AttributeCatalog = {
    rules: bundle.rules,
    character: bundle.character,
    system: bundle.system,
    loadouts: bundle.loadouts,
    effects: bundle.effects,
    initialLoadoutId: bundle.initialLoadoutId,
  };
  return new AttributeService(catalog);
}

/** 求值冒烟：规则集必须能算出至少一个有限属性，杜绝发布空属性表。 */
function assertNonEmpty(service: AttributeService, version: string): void {
  const attributes = service.listAttributes();
  if (attributes.length === 0) {
    throw new Error(`版本 ${version} 求值得到空属性表，拒绝发布`);
  }
  for (const attribute of attributes) {
    if (!Number.isFinite(attribute.value)) {
      throw new Error(`版本 ${version} 的属性 ${attribute.id} 求值结果非有限数值，拒绝发布`);
    }
  }
}

export function summarizeIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `[${issue.code}] ${issue.message}`).join('；');
}

export { toConfigurationCandidate };
