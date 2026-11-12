import type {
  AttributeId,
  AttributeRule,
  DependencyEdgeView,
  DependencyGraphView,
  Modifier,
  PipelineStep,
  SourceDefinition,
  SourceId,
  ValidationIssue,
  ValidationReport,
} from './types.js';
import { isFiniteNumber } from './numeric.js';

/** 每种来源允许贡献的算子（桶）。基础来源只提供基础数值，派生来源只做换算。 */
export const SOURCE_KIND_OPERATORS: Readonly<Record<SourceDefinition['kind'], readonly Modifier['op'][]>> = {
  base: ['base'],
  equipment: ['flat', 'percent', 'override', 'derive'],
  buff: ['flat', 'percent', 'override', 'derive'],
  pressure: ['flat', 'percent', 'override', 'derive'],
  derived: ['derive'],
};

export const REQUIRED_STEPS: readonly PipelineStep[] = [
  'addBase',
  'addFlat',
  'multiplyPercent',
  'addDerived',
  'applyOverride',
  'clamp',
];

export const STEP_TO_OPERATOR: Readonly<Record<Exclude<PipelineStep, 'clamp'>, Modifier['op']>> = {
  addBase: 'base',
  addFlat: 'flat',
  multiplyPercent: 'percent',
  addDerived: 'derive',
  applyOverride: 'override',
};

export function validateAttributeRules(rules: readonly AttributeRule[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<AttributeId>();

  for (const rule of rules) {
    const ruleIssues: ValidationIssue[] = [];
    if (seen.has(rule.id)) {
      ruleIssues.push({ code: 'duplicate-attribute', message: `属性 ${rule.id} 重复定义`, attributes: [rule.id] });
    }
    seen.add(rule.id);

    const steps = rule.pipeline;
    const validStepSet = new Set<PipelineStep>(REQUIRED_STEPS);
    const unknownSteps = steps.filter((step) => !validStepSet.has(step));
    const duplicates = steps.filter((step, index) => steps.indexOf(step) !== index);
    const clampCount = steps.filter((step) => step === 'clamp').length;
    if (unknownSteps.length > 0 || duplicates.length > 0 || clampCount !== 1 || steps.at(-1) !== 'clamp') {
      issues.push({
        code: 'invalid-pipeline',
        message: `属性 ${rule.id} 的规则步骤非法：允许的步骤为 ${REQUIRED_STEPS.join(' / ')}，clamp 必须出现且仅在最后；实际为 ${steps.join(' → ')}`,
        attributes: [rule.id],
      });
    }

    if (!(Number.isInteger(rule.precision) && rule.precision >= 0 && rule.precision <= 8)) {
      ruleIssues.push({
        code: 'invalid-number',
        message: `属性 ${rule.id} 的精度必须是 0..8 的整数`,
        attributes: [rule.id],
      });
    }
    if (!isFiniteNumber(rule.clamp.min) || !isFiniteNumber(rule.clamp.max) || rule.clamp.min > rule.clamp.max) {
      ruleIssues.push({
        code: 'invalid-number',
        message: `属性 ${rule.id} 的钳位区间无效`,
        attributes: [rule.id],
      });
    }
    issues.push(...ruleIssues);
  }
  return issues;
}

export function validateModifiers(
  rules: readonly AttributeRule[],
  sources: readonly SourceDefinition[],
  modifiers: readonly Modifier[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const attributeIds = new Set(rules.map((rule) => rule.id));
  const sourceById = new Map<SourceId, SourceDefinition>();
  const modifierIds = new Set<string>();

  for (const source of sources) {
    if (sourceById.has(source.id)) {
      issues.push({ code: 'duplicate-source', message: `来源 ${source.id} 重复定义`, sources: [source.id] });
    }
    sourceById.set(source.id, source);
    if (!(source.kind in SOURCE_KIND_OPERATORS)) {
      issues.push({ code: 'invalid-source-kind', message: `来源 ${source.id} 的类型 ${String(source.kind)} 非法`, sources: [source.id] });
    }
  }

  for (const modifier of modifiers) {
    if (modifierIds.has(modifier.id)) {
      issues.push({ code: 'duplicate-modifier', message: `修正 ${modifier.id} 重复定义`, modifiers: [modifier.id] });
    }
    modifierIds.add(modifier.id);

    const source = sourceById.get(modifier.sourceId);
    if (!source) {
      issues.push({
        code: 'unknown-source',
        message: `修正 ${modifier.id} 引用了不存在的来源 ${modifier.sourceId}`,
        sources: [modifier.sourceId],
        modifiers: [modifier.id],
      });
      continue;
    }
    if (!attributeIds.has(modifier.attribute)) {
      issues.push({
        code: 'unknown-attribute',
        message: `修正 ${modifier.id} 引用了不存在的属性 ${modifier.attribute}`,
        attributes: [modifier.attribute],
        modifiers: [modifier.id],
      });
      continue;
    }
    const allowed = SOURCE_KIND_OPERATORS[source.kind];
    if (!allowed.includes(modifier.op)) {
      issues.push({
        code: 'invalid-source-kind',
        message: `来源 ${source.id}（${source.kind}）不得提供 ${modifier.op} 修正`,
        sources: [source.id],
        modifiers: [modifier.id],
      });
    }
    const numeric = modifier.op === 'derive'
      ? [modifier.value, modifier.offset]
      : [modifier.value];
    if (!numeric.every(isFiniteNumber)) {
      issues.push({
        code: 'invalid-number',
        message: `修正 ${modifier.id} 含有非有限数值`,
        modifiers: [modifier.id],
      });
    }
  }
  return issues;
}

export function validateUsage(
  rules: readonly AttributeRule[],
  modifiers: readonly Modifier[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const operatorsForAttribute = new Map<AttributeId, Set<Modifier['op']>>();
  for (const rule of rules) {
    operatorsForAttribute.set(
      rule.id,
      new Set(
        rule.pipeline
          .filter((step): step is Exclude<PipelineStep, 'clamp'> => step !== 'clamp')
          .map((step) => STEP_TO_OPERATOR[step]),
      ),
    );
  }

  for (const modifier of modifiers) {
    const allowed = operatorsForAttribute.get(modifier.attribute);
    if (!allowed) continue;
    if (!allowed.has(modifier.op)) {
      issues.push({
        code: 'unconsumed-modifier',
        message: `属性 ${modifier.attribute} 的规则不含 ${modifier.op} 步骤，修正 ${modifier.id} 不会被求值`,
        attributes: [modifier.attribute],
        modifiers: [modifier.id],
      });
    }
  }
  return issues;
}

export function buildDependencyEdges(
  sources: readonly SourceDefinition[],
  modifiers: readonly Modifier[],
): DependencyEdgeView[] {
  const kindBySource = new Map(sources.map((source) => [source.id, source.kind]));
  const edges: DependencyEdgeView[] = [];
  for (const modifier of modifiers) {
    if (modifier.op !== 'derive') continue;
    edges.push({
      from: modifier.attribute,
      to: modifier.dependsOn[0]!,
      modifierId: modifier.id,
      sourceId: modifier.sourceId,
      sourceKind: kindBySource.get(modifier.sourceId) ?? 'derived',
    });
  }
  return edges;
}

export function validateDependencyGraph(
  rules: readonly AttributeRule[],
  modifiers: readonly Modifier[],
  sources: readonly SourceDefinition[],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const edges = buildDependencyEdges(sources, modifiers);
  const adjacency = new Map<AttributeId, DependencyEdgeView[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }

  const state = new Map<AttributeId, 'visiting' | 'done'>();
  const stack: AttributeId[] = [];
  const reportedCycles = new Set<string>();

  const visit = (node: AttributeId): void => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      const target = edge.to;
      const targetState = state.get(target);
      if (targetState === 'visiting') {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target];
        const key = [...cycle].sort().join('|');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          const participants = cycle.slice(0, -1);
          issues.push({
            code: 'dependency-cycle',
            message: `依赖图存在循环：${cycle.join(' → ')}（参与节点 ${participants.join('、')}）`,
            attributes: participants,
            modifiers: cycleEdges(edges, cycle).map((entry) => entry.modifierId),
          });
        }
        continue;
      }
      if (targetState === undefined) {
        visit(target);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const rule of rules) {
    if (state.get(rule.id) === undefined) visit(rule.id);
  }

  // 自环在 DFS 里已经覆盖；这里额外保证每个依赖边都在被依赖属性上可求值。
  return finishReport(issues);
}

function cycleEdges(edges: readonly DependencyEdgeView[], cycle: readonly AttributeId[]): DependencyEdgeView[] {
  const result: DependencyEdgeView[] = [];
  for (let i = 0; i < cycle.length - 1; i += 1) {
    const from = cycle[i]!;
    const to = cycle[i + 1]!;
    const edge = edges.find((candidate) => candidate.from === from && candidate.to === to);
    if (edge) result.push(edge);
  }
  return result;
}

export function finishReport(issues: readonly ValidationIssue[]): ValidationReport {
  return { ok: issues.length === 0, issues };
}
