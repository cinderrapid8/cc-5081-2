/**
 * 角色属性求值服务 - 公共类型定义
 *
 * 一条属性规则决定求值顺序；每一个修正都挂在某个来源上，来源是撤销的最小单位。
 * 所有数值来源都通过 (sourceId, modifierId) 双重身份标识，避免按数值删除修正。
 */

export type AttributeId = string;
export type SourceId = string;
export type ModifierId = string;
export type LoadoutId = string;

export type SourceKind = 'base' | 'equipment' | 'buff' | 'pressure' | 'derived';

export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  base: '基础数值',
  equipment: '装备修正',
  buff: '临时增益',
  pressure: '场景压制',
  derived: '派生换算',
};

export interface SourceDefinition {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly label: string;
  /** 达到该回合时移除；省略表示常驻。 */
  readonly expiresAtTick?: number;
}

interface ModifierCommon {
  readonly id: ModifierId;
  readonly sourceId: SourceId;
  readonly attribute: AttributeId;
}

/** 基础数值桶。仅允许由 kind === "base" 的来源提供。 */
export interface BaseModifier extends ModifierCommon {
  readonly op: 'base';
  readonly value: number;
}

/** 固定加值。 */
export interface FlatModifier extends ModifierCommon {
  readonly op: 'flat';
  readonly value: number;
}

/** 百分比修正，以比率表示：0.15 表示 +15%，-0.4 表示 -40%。 */
export interface PercentModifier extends ModifierCommon {
  readonly op: 'percent';
  readonly value: number;
}

/** 覆盖修正。同属性上按 priority 降序、modifierId 升序确定唯一胜者。 */
export interface OverrideModifier extends ModifierCommon {
  readonly op: 'override';
  readonly value: number;
  readonly priority: number;
}

/** 派生修正：value = 依赖属性最终值 * value + offset。 */
export interface DeriveModifier extends ModifierCommon {
  readonly op: 'derive';
  readonly value: number;
  readonly offset: number;
  readonly dependsOn: readonly [AttributeId];
}

export type Modifier =
  | BaseModifier
  | FlatModifier
  | PercentModifier
  | OverrideModifier
  | DeriveModifier;

/** 规则声明的求值步骤，顺序即语义。 */
export type PipelineStep =
  | 'addBase'
  | 'addFlat'
  | 'multiplyPercent'
  | 'addDerived'
  | 'applyOverride'
  | 'clamp';

export const PIPELINE_STEP_LABELS: Readonly<Record<PipelineStep, string>> = {
  addBase: '加入基础值',
  addFlat: '加入固定加值',
  multiplyPercent: '百分比乘算',
  addDerived: '加入派生值',
  applyOverride: '应用覆盖',
  clamp: '最终钳位',
};

export interface AttributeRule {
  readonly id: AttributeId;
  readonly label: string;
  readonly description: string;
  /** 必须先包含所需来源桶，最后一步必须是唯一的 clamp。 */
  readonly pipeline: readonly PipelineStep[];
  readonly clamp: { readonly min: number; readonly max: number };
  /** 每步求值后保留的小数位数，用于消除浮点噪声。 */
  readonly precision: number;
}

export interface CharacterDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseSource: SourceDefinition;
  readonly baseModifiers: readonly Modifier[];
}

export interface SystemDefinition {
  readonly sources: readonly SourceDefinition[];
  readonly modifiers: readonly Modifier[];
}

export interface LoadoutDefinition {
  readonly id: LoadoutId;
  readonly label: string;
  readonly description: string;
  readonly sources: readonly SourceDefinition[];
  readonly modifiers: readonly Modifier[];
}

export interface EffectTemplate {
  readonly id: SourceId;
  readonly label: string;
  readonly description: string;
  readonly kind: SourceKind;
  readonly durationTicks: number;
  readonly modifiers: readonly Modifier[];
}

export interface AttributeCatalog {
  readonly rules: readonly AttributeRule[];
  readonly character: CharacterDefinition;
  readonly system: SystemDefinition;
  readonly loadouts: readonly LoadoutDefinition[];
  readonly effects: readonly EffectTemplate[];
  readonly initialLoadoutId: LoadoutId;
}

export interface ConfigurationCandidate {
  readonly rules: readonly AttributeRule[];
  readonly sources: readonly SourceDefinition[];
  readonly modifiers: readonly Modifier[];
}

export type ValidationCode =
  | 'duplicate-attribute'
  | 'invalid-pipeline'
  | 'duplicate-source'
  | 'duplicate-modifier'
  | 'unknown-source'
  | 'unknown-attribute'
  | 'missing-dependency'
  | 'unconsumed-modifier'
  | 'invalid-source-kind'
  | 'invalid-number'
  | 'dependency-cycle';

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly message: string;
  readonly attributes?: readonly AttributeId[];
  readonly sources?: readonly SourceId[];
  readonly modifiers?: readonly ModifierId[];
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface DependencyEdgeView {
  readonly from: AttributeId;
  readonly to: AttributeId;
  readonly modifierId: ModifierId;
  readonly sourceId: SourceId;
  readonly sourceKind: SourceKind;
}

export interface DependencyGraphView {
  readonly nodes: readonly AttributeId[];
  readonly edges: readonly DependencyEdgeView[];
}

export interface DependencyValue {
  readonly attribute: AttributeId;
  readonly value: number;
  readonly modifierId: ModifierId;
}

export interface StepTrace {
  readonly step: PipelineStep;
  readonly inputValue: number;
  readonly outputValue: number;
  readonly delta: number;
  readonly applied: boolean;
  /**
   * 该步骤的桶汇总：
   * - 基础/固定/派生：来源数值合计
   * - 百分比：比率合计（0.15 即 +15%）
   * - 覆盖：胜出值
   * - 钳位：null
   */
  readonly aggregate: number | null;
}

export interface ContributionView {
  readonly modifierId: ModifierId;
  readonly sourceId: SourceId;
  readonly sourceKind: SourceKind;
  readonly sourceLabel: string;
  readonly attribute: AttributeId;
  readonly op: Modifier['op'];
  readonly rawValue: number;
  /** 本修正对最终值贡献的增量；覆盖被压制时为 0。 */
  readonly appliedValue: number;
  readonly shadowed: boolean;
  readonly dependency: DependencyValue | null;
  readonly note: string;
}

export interface AttributeExplanation {
  readonly attribute: AttributeId;
  readonly label: string;
  readonly description: string;
  readonly precision: number;
  readonly revision: number;
  readonly tick: number;
  readonly finalValue: number;
  readonly preClampValue: number;
  readonly clamp: {
    readonly min: number;
    readonly max: number;
    readonly clamped: boolean;
  };
  readonly steps: readonly StepTrace[];
  readonly contributions: readonly ContributionView[];
  readonly dependencies: readonly DependencyValue[];
}

export interface AttributeSummary {
  readonly id: AttributeId;
  readonly label: string;
  readonly value: number;
  readonly preClampValue: number;
  readonly clamped: boolean;
  readonly revision: number;
}

export interface ServiceState {
  readonly revision: number;
  readonly tick: number;
  readonly loadoutId: LoadoutId | null;
  readonly loadoutLabel: string | null;
}

export interface LoadoutSummary {
  readonly id: LoadoutId;
  readonly label: string;
  readonly description: string;
}

export interface EffectSummary {
  readonly id: SourceId;
  readonly label: string;
  readonly description: string;
  readonly kind: SourceKind;
  readonly durationTicks: number;
}

export interface ActiveSourceView {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly label: string;
  readonly expiresAtTick: number | null;
  readonly modifierCount: number;
  readonly origin: 'fixed' | 'loadout' | 'runtime';
}

export interface TickReport {
  readonly tick: number;
  readonly removedSourceIds: readonly SourceId[];
  readonly revision: number;
}

/** 游戏逻辑侧直接消费的只读查询接口。 */
export interface AttributeQuery {
  getValue(attribute: AttributeId): number;
  getValues(attributes: readonly AttributeId[]): Readonly<Record<AttributeId, number>>;
  explain(attribute: AttributeId): AttributeExplanation;
  getState(): ServiceState;
  getDependencyGraph(): DependencyGraphView;
}
