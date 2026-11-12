import type {
  AttributeExplanation,
  AttributeSummary,
  ServiceState,
} from '../core/types.js';
import type { AttributeService as Service } from '../core/service.js';
import { formatNumber, formatSigned } from '../core/numeric.js';
import { PIPELINE_STEP_LABELS } from '../core/types.js';

/**
 * 面板视图模型。所有数值都来自 service.explain()/getValues()，
 * 不在这里重新推导公式，保证“展示即求值结果”。
 */

export interface ContributionRow {
  readonly kind: 'contribution';
  readonly modifierId: string;
  readonly sourceLabel: string;
  readonly sourceKindLabel: string;
  readonly sourceId: string;
  readonly op: string;
  readonly input: string;
  readonly applied: string;
  readonly appliedNumber: number;
  readonly shadowed: boolean;
  readonly note: string;
}

export interface StepRow {
  readonly kind: 'step';
  readonly step: string;
  readonly label: string;
  readonly input: string;
  readonly output: string;
  readonly delta: string;
  readonly aggregate: string | null;
  readonly applied: boolean;
}

export interface AttributeCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly valueText: string;
  readonly preClampText: string;
  readonly clamped: boolean;
  readonly steps: readonly StepRow[];
  readonly contributions: readonly ContributionRow[];
  readonly dependencyText: string;
}

export interface SourceChip {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly origin: string;
  readonly originLabel: string;
  readonly expiresText: string;
  readonly modifierCount: number;
}

export interface GraphEdgeRow {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly sourceLabel: string;
  readonly sourceKind: string;
}

export interface PanelModel {
  readonly notice: string | null;
  readonly state: ServiceState;
  readonly revisionText: string;
  readonly tickText: string;
  readonly loadoutText: string;
  readonly loadouts: readonly { id: string; label: string; description: string; active: boolean }[];
  readonly cards: readonly AttributeCard[];
  readonly sources: readonly SourceChip[];
  readonly effects: readonly { id: string; label: string; description: string; activeInstance: string | null }[];
  readonly edges: readonly GraphEdgeRow[];
  readonly selectedAttributeId: string | null;
}

export interface BuildPanelOptions {
  readonly selectedAttributeId: string | null;
  readonly notice: string | null;
}

const SOURCE_KIND_LABELS: Readonly<Record<string, string>> = {
  base: '基础数值',
  equipment: '装备修正',
  buff: '临时增益',
  pressure: '场景压制',
  derived: '派生换算',
};

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  fixed: '常驻',
  loadout: '负载',
  runtime: '运行效果',
};

const OP_LABELS: Readonly<Record<string, string>> = {
  base: '基础值',
  flat: '固定加值',
  percent: '百分比',
  derive: '派生',
  override: '覆盖',
};

export function buildPanelModel(
  service: Service,
  options: BuildPanelOptions,
): PanelModel {
  const summaries: readonly AttributeSummary[] = service.listAttributes();
  const cards = summaries.map((summary) => toCard(service, summary.id));
  const state = service.getState();
  const loadoutId = state.loadoutId;

  const sources: SourceChip[] = service.listActiveSources().map((source) => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    kindLabel: SOURCE_KIND_LABELS[source.kind] ?? source.kind,
    origin: source.origin,
    originLabel: ORIGIN_LABELS[source.origin] ?? source.origin,
    expiresText: source.expiresAtTick === null ? '常驻' : `tick ${source.expiresAtTick}`,
    modifierCount: source.modifierCount,
  }));

  const activeEffects = new Set(service.listActiveEffects().map((effect) => effect.id));
  const effects = service.listEffects().map((effect) => {
    const activeInstance = [...activeEffects].find((id) => id.startsWith(`${effect.id}#`)) ?? null;
    return {
      id: effect.id,
      label: effect.label,
      description: effect.description,
      activeInstance,
    };
  });

  const graph = service.getDependencyGraph();
  const edges: GraphEdgeRow[] = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: `${edge.from} 依赖 ${edge.to}`,
    sourceLabel: sources.find((source) => source.id === edge.sourceId)?.label ?? edge.sourceId,
    sourceKind: SOURCE_KIND_LABELS[edge.sourceKind] ?? edge.sourceKind,
  }));

  return {
    notice: options.notice,
    state,
    revisionText: `revision ${state.revision}`,
    tickText: `tick ${state.tick}`,
    loadoutText: state.loadoutLabel ?? '（无负载）',
    loadouts: service.listLoadouts().map((loadout) => ({
      ...loadout,
      active: loadout.id === loadoutId,
    })),
    cards,
    sources,
    effects,
    edges,
    selectedAttributeId: options.selectedAttributeId,
  };
}

function toCard(service: Service, attributeId: string): AttributeCard {
  const explanation: AttributeExplanation = service.explain(attributeId);
  const precision = explanation.precision;
  const steps: StepRow[] = explanation.steps.map((step) => ({
    kind: 'step',
    step: step.step,
    label: PIPELINE_STEP_LABELS[step.step],
    input: formatNumber(step.inputValue, precision),
    output: formatNumber(step.outputValue, precision),
    delta: formatSigned(step.delta, precision),
    aggregate:
      step.aggregate === null
        ? null
        : step.step === 'multiplyPercent'
          ? `${formatSigned(step.aggregate * 100, precision)}%`
          : formatNumber(step.aggregate, precision),
    applied: step.applied,
  }));

  const contributions: ContributionRow[] = explanation.contributions.map((contribution) => ({
    kind: 'contribution',
    modifierId: contribution.modifierId,
    sourceLabel: contribution.sourceLabel,
    sourceKindLabel: SOURCE_KIND_LABELS[contribution.sourceKind] ?? contribution.sourceKind,
    sourceId: contribution.sourceId,
    op: OP_LABELS[contribution.op] ?? contribution.op,
    input:
      contribution.op === 'percent'
        ? `${formatNumber(contribution.rawValue * 100, precision)}%`
        : formatNumber(contribution.rawValue, precision),
    applied: formatSigned(contribution.appliedValue, precision),
    appliedNumber: contribution.appliedValue,
    shadowed: contribution.shadowed,
    note: contribution.note,
  }));

  const dependencyText = explanation.dependencies.length === 0
    ? '无派生依赖'
    : explanation.dependencies
      .map((dependency) => `${dependency.attribute} = ${formatNumber(dependency.value, precision)}`)
      .join('，');

  return {
    id: explanation.attribute,
    label: explanation.label,
    description: explanation.description,
    value: explanation.finalValue,
    valueText: formatNumber(explanation.finalValue, precision),
    preClampText: formatNumber(explanation.preClampValue, precision),
    clamped: explanation.clamp.clamped,
    steps,
    contributions,
    dependencyText,
  };
}
