import type {
  AttributeCatalog,
  AttributeExplanation,
  AttributeId,
  AttributeQuery,
  AttributeRule,
  AttributeSummary,
  ConfigurationCandidate,
  DependencyGraphView,
  EffectSummary,
  LoadoutDefinition,
  LoadoutId,
  LoadoutSummary,
  Modifier,
  ServiceState,
  SourceDefinition,
  SourceId,
  SourceKind,
  TickReport,
  ValidationReport,
  ActiveSourceView,
} from './types.js';
import { evaluateSnapshot, EvaluationError, type EvaluationSnapshot } from './evaluate.js';
import {
  buildDependencyEdges,
  finishReport,
  validateAttributeRules,
  validateDependencyGraph,
  validateModifiers,
  validateUsage,
} from './validate.js';

export interface ConfigurationResult {
  readonly accepted: boolean;
  readonly report: ValidationReport;
  readonly revision: number;
}

export interface SourceExplanation {
  readonly sourceId: SourceId;
  readonly label: string;
  readonly kind: SourceKind;
  readonly active: boolean;
  readonly origin: ActiveSourceView['origin'] | null;
  readonly expiresAtTick: number | null;
  readonly modifiers: readonly {
    readonly modifierId: string;
    readonly attribute: AttributeId;
    readonly op: Modifier['op'];
    readonly rawValue: number;
    readonly appliedValue: number;
    readonly shadowed: boolean;
  }[];
}

interface MountedSource {
  readonly holderKind: 'base' | 'system' | 'loadout' | 'effect';
  readonly holderId: string;
  readonly source: SourceDefinition;
  readonly modifiers: readonly Modifier[];
}

function originOf(holderKind: MountedSource['holderKind']): ActiveSourceView['origin'] {
  return holderKind === 'effect' ? 'runtime' : holderKind === 'loadout' ? 'loadout' : 'fixed';
}

const LOADOUT_SOURCE_KEY = (loadoutId: string, sourceId: string) => `loadout:${loadoutId}:${sourceId}`;
const EFFECT_KEY = (instanceId: string) => `effect:${instanceId}`;

export class ConfigurationRejectedError extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(`配置被拒绝：${report.issues.map((issue) => issue.message).join('；')}`);
    this.name = 'ConfigurationRejectedError';
    this.report = report;
  }
}

/**
 * 角色属性求值服务。对外暴露的读写接口分为：
 * - 查询：getValue / getValues / explain / explainSource / getDependencyGraph
 * - 负载：switchLoadout
 * - 运行效果：activateEffect / deactivateEffect / advanceTick
 * - 配置事务：validateConfiguration / applyConfiguration
 *
 * 任何变更都只通过来源身份（sourceId / instanceId）撤销，修正从不按数值匹配。
 */
export class AttributeService implements AttributeQuery {
  private rules: readonly AttributeRule[];
  private systemSources: readonly SourceDefinition[];
  private systemModifiers: readonly Modifier[];
  private readonly character: AttributeCatalog['character'];
  private readonly mounts = new Map<string, MountedSource>();
  private loadout: LoadoutDefinition | null;
  private effectInstanceSeq = 0;
  private revisionCounter = 0;
  private currentTick = 0;
  private snapshotCache: { revision: number; snapshot: EvaluationSnapshot } | null = null;

  constructor(private readonly catalog: AttributeCatalog) {
    this.rules = catalog.rules;
    this.systemSources = catalog.system.sources;
    this.systemModifiers = catalog.system.modifiers;
    this.character = catalog.character;
    this.loadout = null;

    const initial = catalog.loadouts.find((candidate) => candidate.id === catalog.initialLoadoutId);
    if (!initial) {
      throw new ConfigurationRejectedError(
        finishReport([
          {
            code: 'unknown-attribute',
            message: `初始负载 ${catalog.initialLoadoutId} 不存在`,
          },
        ]),
      );
    }

    const initialReport = this.checkFullState({
      rules: this.rules,
      character: this.character,
      system: { sources: this.systemSources, modifiers: this.systemModifiers },
      loadout: initial,
      effects: [],
    });
    if (!initialReport.ok) {
      throw new ConfigurationRejectedError(initialReport);
    }

    this.loadout = initial;
    this.mountLoadout(initial);
    this.revisionCounter = 1;
  }

  // ---------------------------------------------------------------- 查询

  getState(): ServiceState {
    return {
      revision: this.revisionCounter,
      tick: this.currentTick,
      loadoutId: this.loadout?.id ?? null,
      loadoutLabel: this.loadout?.label ?? null,
    };
  }

  listAttributes(): readonly AttributeSummary[] {
    const snapshot = this.snapshot();
    return this.rules.map((rule) => {
      const explanation = snapshot.explanationByAttribute.get(rule.id);
      if (!explanation) {
        throw new EvaluationError(`属性 ${rule.id} 未出现在求值结果中`);
      }
      return {
        id: rule.id,
        label: rule.label,
        value: explanation.finalValue,
        preClampValue: explanation.preClampValue,
        clamped: explanation.clamp.clamped,
        revision: this.revisionCounter,
      };
    });
  }

  getValue(attribute: AttributeId): number {
    const value = this.snapshot().valueByAttribute.get(attribute);
    if (value === undefined) {
      throw new EvaluationError(`未知属性 ${attribute}`);
    }
    return value;
  }

  getValues(attributes: readonly AttributeId[]): Readonly<Record<AttributeId, number>> {
    const snapshot = this.snapshot();
    const result: Record<AttributeId, number> = {};
    for (const attribute of attributes) {
      const value = snapshot.valueByAttribute.get(attribute);
      if (value === undefined) {
        throw new EvaluationError(`未知属性 ${attribute}`);
      }
      result[attribute] = value;
    }
    return Object.freeze(result);
  }

  explain(attribute: AttributeId): AttributeExplanation {
    const explanation = this.snapshot().explanationByAttribute.get(attribute);
    if (!explanation) {
      throw new EvaluationError(`未知属性 ${attribute}`);
    }
    // 快照按 revision 缓存；解释对象直接来自本次求值，面板展示的必须是它而不是重算结果。
    return explanation;
  }

  getDependencyGraph(): DependencyGraphView {
    const active = this.activeSources();
    return {
      nodes: this.rules.map((rule) => rule.id),
      edges: buildDependencyEdges(active.sources, active.modifiers),
    };
  }

  // ---------------------------------------------------------------- 负载

  listLoadouts(): readonly LoadoutSummary[] {
    return this.catalog.loadouts.map((loadout) => ({
      id: loadout.id,
      label: loadout.label,
      description: loadout.description,
    }));
  }

  getActiveLoadoutId(): LoadoutId | null {
    return this.loadout?.id ?? null;
  }

  /**
   * 切换负载是一次整图事务：新负载与当前规则、运行效果合并后先校验，
   * 校验失败时不改动任何已装载来源。
   */
  switchLoadout(loadoutId: LoadoutId): ConfigurationResult {
    const next = this.catalog.loadouts.find((candidate) => candidate.id === loadoutId);
    if (!next) {
      return {
        accepted: false,
        report: finishReport([
          { code: 'unknown-attribute', message: `负载 ${loadoutId} 不存在` },
        ]),
        revision: this.revisionCounter,
      };
    }
    const report = this.checkFullState({
      rules: this.rules,
      character: this.character,
      system: { sources: this.systemSources, modifiers: this.systemModifiers },
      loadout: next,
      effects: this.activeEffects(),
    });
    if (!report.ok) {
      return { accepted: false, report, revision: this.revisionCounter };
    }

    this.unmountHolder('loadout');
    this.loadout = next;
    this.mountLoadout(next);
    this.bumpRevision();
    return { accepted: true, report, revision: this.revisionCounter };
  }

  // ---------------------------------------------------------------- 运行效果

  listEffects(): readonly EffectSummary[] {
    return this.catalog.effects.map((effect) => ({
      id: effect.id,
      label: effect.label,
      description: effect.description,
      kind: effect.kind,
      durationTicks: effect.durationTicks,
    }));
  }

  activateEffect(templateId: SourceId): { instanceId: SourceId; revision: number } {
    const template = this.catalog.effects.find((candidate) => candidate.id === templateId);
    if (!template) {
      throw new EvaluationError(`未知效果模板 ${templateId}`);
    }
    if (!(template.durationTicks > 0)) {
      throw new EvaluationError(`效果 ${templateId} 的持续时间必须大于 0`);
    }
    this.effectInstanceSeq += 1;
    const instanceId = `${template.id}#${this.effectInstanceSeq}`;
    const source: SourceDefinition = {
      id: instanceId,
      kind: template.kind,
      label: template.label,
      expiresAtTick: this.currentTick + template.durationTicks,
    };
    const modifiers = template.modifiers.map((modifier) => ({
      ...modifier,
      id: `${modifier.id}#${this.effectInstanceSeq}`,
      sourceId: instanceId,
    }));

    const report = this.checkFullState({
      rules: this.rules,
      character: this.character,
      system: { sources: this.systemSources, modifiers: this.systemModifiers },
      loadout: this.loadout,
      effects: [...this.activeEffects(), { instanceId, source, modifiers }],
    });
    if (!report.ok) {
      throw new ConfigurationRejectedError(report);
    }

    this.mounts.set(EFFECT_KEY(instanceId), {
      holderKind: 'effect',
      holderId: instanceId,
      source,
      modifiers,
    });
    this.bumpRevision();
    return { instanceId, revision: this.revisionCounter };
  }

  deactivateEffect(instanceId: SourceId): boolean {
    return this.unmountKey(EFFECT_KEY(instanceId));
  }

  listActiveEffects(): readonly ActiveSourceView[] {
    return this.listActiveSources().filter((view) => view.origin === 'runtime');
  }

  /**
   * 推进时间。同一刻到期的多个来源在单次事务里一起撤销，
   * 只产生一个 revision，随后整图重新求值一次。
   */
  advanceTick(ticks = 1): TickReport {
    if (!(Number.isInteger(ticks) && ticks > 0)) {
      throw new EvaluationError(`tick 推进量必须是正整数，收到 ${ticks}`);
    }
    this.currentTick += ticks;
    const expired: string[] = [];
    for (const [key, mounted] of this.mounts) {
      const expiresAt = mounted.source.expiresAtTick;
      if (expiresAt !== undefined && expiresAt <= this.currentTick) {
        expired.push(key);
      }
    }
    const removedSourceIds: SourceId[] = [];
    for (const key of expired) {
      const mounted = this.mounts.get(key);
      if (!mounted) continue;
      removedSourceIds.push(mounted.source.id);
      this.mounts.delete(key);
    }
    if (removedSourceIds.length > 0) {
      this.bumpRevision();
    } else {
      // tick 单独变化也要让 explain() 的 tick 字段反映当前时间。
      this.snapshotCache = null;
    }
    return {
      tick: this.currentTick,
      removedSourceIds,
      revision: this.revisionCounter,
    };
  }

  // ---------------------------------------------------------------- 来源

  /**
   * 卸下单个来源。只按 (holder, sourceId) 身份撤销对应修正，
   * 数值相同的其他来源完全不受影响。
   */
  detachSource(sourceId: SourceId): boolean {
    const fixed = this.fixedSources().find((entry) => entry.source.id === sourceId);
    if (fixed) {
      throw new EvaluationError(`来源 ${sourceId} 属于常驻系统来源，不能单独卸下`);
    }
    const matches = [...this.mounts.entries()].filter(([, mounted]) => mounted.source.id === sourceId);
    if (matches.length > 1) {
      throw new EvaluationError(`来源 ${sourceId} 存在多个活动实例，请使用实例 id 精确卸载`);
    }
    const match = matches[0];
    if (!match) return false;
    this.mounts.delete(match[0]);
    this.bumpRevision();
    return true;
  }

  listActiveSources(): readonly ActiveSourceView[] {
    const mountedList = this.activeSources().mounted;
    return mountedList.map((mounted) => ({
      id: mounted.source.id,
      kind: mounted.source.kind,
      label: mounted.source.label,
      expiresAtTick: mounted.source.expiresAtTick ?? null,
      modifierCount: mounted.modifiers.length,
      origin: originOf(mounted.holderKind),
    }));
  }

  explainSource(sourceId: SourceId): SourceExplanation | null {
    const active = this.activeSources();
    const mounted = active.mounted.find((entry) => entry.source.id === sourceId);
    const fixed = this.fixedSources().find((entry) => entry.source.id === sourceId);
    const explanationByAttribute = this.snapshot().explanationByAttribute;
    const target: { source: SourceDefinition; modifiers: readonly Modifier[]; holderKind: MountedSource['holderKind'] } | null =
      mounted
        ? { source: mounted.source, modifiers: mounted.modifiers, holderKind: mounted.holderKind }
        : fixed
          ? { source: fixed.source, modifiers: fixed.modifiers, holderKind: fixed.source === this.character.baseSource ? 'base' : 'system' }
          : null;
    if (!target) {
      const template = this.catalog.effects.find((effect) => effect.id === sourceId);
      if (!template) return null;
      return {
        sourceId,
        label: template.label,
        kind: template.kind,
        active: false,
        origin: null,
        expiresAtTick: null,
        modifiers: [],
      };
    }
    const modifiers = target.modifiers.map((modifier) => {
      const explanation = explanationByAttribute.get(modifier.attribute);
      const contribution = explanation?.contributions.find(
        (candidate) => candidate.modifierId === modifier.id,
      );
      return {
        modifierId: modifier.id,
        attribute: modifier.attribute,
        op: modifier.op,
        rawValue: contribution?.rawValue ?? modifier.value,
        appliedValue: contribution?.appliedValue ?? 0,
        shadowed: contribution?.shadowed ?? false,
      };
    });
    return {
      sourceId,
      label: target.source.label,
      kind: target.source.kind,
      active: true,
      origin: originOf(target.holderKind),
      expiresAtTick: target.source.expiresAtTick ?? null,
      modifiers,
    };
  }

  // ---------------------------------------------------------------- 配置事务

  /**
   * 整图检查：候选规则/系统来源与当前角色基础、活动负载、运行效果合并后，
   * 依次检查重复定义、缺失依赖、来源类型、求值步骤覆盖与依赖循环。
   */
  validateConfiguration(candidate: ConfigurationCandidate): ValidationReport {
    return this.checkFullState({
      rules: candidate.rules,
      character: this.character,
      system: { sources: candidate.sources, modifiers: candidate.modifiers },
      loadout: this.loadout,
      effects: this.activeEffects(),
    });
  }

  /**
   * 先校验整图，全部通过后才替换。失败时服务保持旧状态，旧快照仍可求值。
   */
  applyConfiguration(candidate: ConfigurationCandidate): ConfigurationResult {
    const report = this.validateConfiguration(candidate);
    if (!report.ok) {
      return { accepted: false, report, revision: this.revisionCounter };
    }
    this.rules = candidate.rules;
    this.systemSources = candidate.sources;
    this.systemModifiers = candidate.modifiers;
    this.bumpRevision();
    return { accepted: true, report, revision: this.revisionCounter };
  }

  // ---------------------------------------------------------------- 内部

  private snapshot(): EvaluationSnapshot {
    if (this.snapshotCache && this.snapshotCache.revision === this.revisionCounter) {
      return this.snapshotCache.snapshot;
    }
    const active = this.activeSources();
    const snapshot = evaluateSnapshot({
      rules: this.rules,
      sources: active.sources,
      modifiers: active.modifiers,
      revision: this.revisionCounter,
      tick: this.currentTick,
    });
    this.snapshotCache = { revision: this.revisionCounter, snapshot };
    return snapshot;
  }

  private activeSources(): {
    sources: SourceDefinition[];
    modifiers: Modifier[];
    mounted: MountedSource[];
  } {
    const sources: SourceDefinition[] = [this.character.baseSource, ...this.systemSources];
    const modifiers: Modifier[] = [...this.character.baseModifiers, ...this.systemModifiers];
    const mounted: MountedSource[] = [];
    for (const entry of this.mounts.values()) {
      sources.push(entry.source);
      modifiers.push(...entry.modifiers);
      mounted.push(entry);
    }
    return { sources, modifiers, mounted };
  }

  private activeEffects(): { instanceId: string; source: SourceDefinition; modifiers: readonly Modifier[] }[] {
    const effects: { instanceId: string; source: SourceDefinition; modifiers: readonly Modifier[] }[] = [];
    for (const mounted of this.mounts.values()) {
      if (mounted.holderKind !== 'effect') continue;
      effects.push({ instanceId: mounted.holderId, source: mounted.source, modifiers: mounted.modifiers });
    }
    return effects;
  }


  private mountLoadout(loadout: LoadoutDefinition): void {
    for (const source of loadout.sources) {
      this.mounts.set(LOADOUT_SOURCE_KEY(loadout.id, source.id), {
        holderKind: 'loadout',
        holderId: loadout.id,
        source,
        modifiers: loadout.modifiers.filter((modifier) => modifier.sourceId === source.id),
      });
    }
  }

  private fixedSources(): { source: SourceDefinition; modifiers: readonly Modifier[] }[] {
    return [
      { source: this.character.baseSource, modifiers: this.character.baseModifiers },
      ...this.systemSources.map((source) => ({
        source,
        modifiers: this.systemModifiers.filter((modifier) => modifier.sourceId === source.id),
      })),
    ];
  }

  private unmountHolder(kind: MountedSource['holderKind'], holderId?: string): void {
    for (const [key, mounted] of this.mounts) {
      if (mounted.holderKind !== kind) continue;
      if (holderId !== undefined && mounted.holderId !== holderId) continue;
      this.mounts.delete(key);
    }
  }

  private unmountKey(key: string): boolean {
    return this.mounts.delete(key);
  }

  private bumpRevision(): void {
    this.revisionCounter += 1;
    this.snapshotCache = null;
  }

  private checkFullState(input: {
    rules: readonly AttributeRule[];
    character: AttributeCatalog['character'];
    system: { sources: readonly SourceDefinition[]; modifiers: readonly Modifier[] };
    loadout: LoadoutDefinition | null;
    effects: readonly { instanceId: string; source: SourceDefinition; modifiers: readonly Modifier[] }[];
  }): ValidationReport {
    const issues = [
      ...validateAttributeRules(input.rules),
    ];

    // 来源与修正的完整集合：角色基础 + 候选系统 + 活动负载 + 运行效果。
    const sources: SourceDefinition[] = [input.character.baseSource, ...input.system.sources];
    const modifiers: Modifier[] = [...input.character.baseModifiers, ...input.system.modifiers];
    if (input.loadout) {
      sources.push(...input.loadout.sources);
      modifiers.push(...input.loadout.modifiers);
    }
    for (const effect of input.effects) {
      sources.push(effect.source);
      modifiers.push(...effect.modifiers);
    }

    const knownAttributes = new Set(input.rules.map((rule) => rule.id));
    const sourceIds = new Set<string>();
    for (const source of sources) {
      if (sourceIds.has(source.id)) {
        issues.push({
          code: 'duplicate-source',
          message: `来源 ${source.id} 同时存在于多个持有者，无法按身份撤销`,
          sources: [source.id],
        });
      }
      sourceIds.add(source.id);
    }

    // 缺失依赖先于求值，避免整图求值时才抛异常。
    for (const modifier of modifiers) {
      if (modifier.op !== 'derive') continue;
      const dependency = modifier.dependsOn[0];
      if (!dependency || !knownAttributes.has(dependency)) {
        issues.push({
          code: 'missing-dependency',
          message: `修正 ${modifier.id} 依赖的属性 ${dependency ?? '(空)'} 不存在或不在新规则中`,
          attributes: dependency ? [dependency] : [],
          modifiers: [modifier.id],
        });
      }
    }

    issues.push(...validateModifiers(input.rules, sources, modifiers));
    issues.push(...validateUsage(input.rules, modifiers));
    issues.push(...validateDependencyGraph(input.rules, modifiers, sources).issues);
    return finishReport(issues);
  }
}
