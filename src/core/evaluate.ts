import type {
  AttributeExplanation,
  AttributeId,
  AttributeRule,
  ContributionView,
  DependencyEdgeView,
  DependencyValue,
  Modifier,
  SourceDefinition,
  SourceId,
  StepTrace,
} from './types.js';
import { formatSigned, normalizeZero, roundTo } from './numeric.js';

export interface EvaluationInput {
  readonly rules: readonly AttributeRule[];
  readonly sources: readonly SourceDefinition[];
  readonly modifiers: readonly Modifier[];
  readonly revision?: number;
  readonly tick?: number;
}

export interface EvaluationSnapshot {
  readonly valueByAttribute: ReadonlyMap<AttributeId, number>;
  readonly preClampByAttribute: ReadonlyMap<AttributeId, number>;
  readonly explanationByAttribute: ReadonlyMap<AttributeId, AttributeExplanation>;
  readonly edges: readonly DependencyEdgeView[];
  readonly evaluationOrder: readonly AttributeId[];
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

interface ModifierBuckets {
  readonly base: Modifier[];
  readonly flat: Modifier[];
  readonly percent: Modifier[];
  readonly derive: Modifier[];
  readonly override: Modifier[];
}

function bucketize(modifiers: readonly Modifier[]): ModifierBuckets {
  const buckets: ModifierBuckets = { base: [], flat: [], percent: [], derive: [], override: [] };
  for (const modifier of modifiers) {
    buckets[modifier.op].push(modifier);
  }
  // 稳定顺序：按修正 id 再按来源，避免 Map 插入顺序泄漏到面板。
  for (const key of ['base', 'flat', 'percent', 'derive', 'override'] as const) {
    buckets[key].sort((a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId));
  }
  return buckets;
}

function dependencyEdges(
  sources: readonly SourceDefinition[],
  modifiers: readonly Modifier[],
): DependencyEdgeView[] {
  const kindBySource = new Map(sources.map((source) => [source.id, source.kind]));
  return modifiers
    .filter((modifier): modifier is Extract<Modifier, { op: 'derive' }> => modifier.op === 'derive')
    .map((modifier) => ({
      from: modifier.attribute,
      to: modifier.dependsOn[0]!,
      modifierId: modifier.id,
      sourceId: modifier.sourceId,
      sourceKind: kindBySource.get(modifier.sourceId) ?? 'derived',
    }));
}

/** 依赖优先的拓扑序：被依赖属性必须先求值。 */
function evaluationOrder(
  rules: readonly AttributeRule[],
  edges: readonly DependencyEdgeView[],
): AttributeId[] {
  const nodes = rules.map((rule) => rule.id);
  const known = new Set(nodes);
  const dependencies = new Map<AttributeId, AttributeId[]>();
  for (const node of nodes) dependencies.set(node, []);
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) {
      throw new EvaluationError(`依赖边 ${edge.from} → ${edge.to} 引用了未声明的属性`);
    }
    dependencies.get(edge.from)!.push(edge.to);
  }

  const order: AttributeId[] = [];
  const state = new Map<AttributeId, 'visiting' | 'done'>();
  const stack: AttributeId[] = [];

  const visit = (node: AttributeId): void => {
    const nodeState = state.get(node);
    if (nodeState === 'done') return;
    if (nodeState === 'visiting') {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      throw new EvaluationError(`属性依赖存在循环：${cycle.join(' → ')}`);
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const dependency of dependencies.get(node) ?? []) {
      visit(dependency);
    }
    stack.pop();
    state.set(node, 'done');
    order.push(node);
  };

  for (const node of nodes) visit(node);
  return order;
}

function sourceLabels(sources: readonly SourceDefinition[]): Map<SourceId, SourceDefinition> {
  return new Map(sources.map((source) => [source.id, source]));
}

function winnerOverride(overrides: readonly Modifier[]): Modifier | null {
  let winner: Modifier | null = null;
  for (const candidate of overrides) {
    if (candidate.op !== 'override') continue;
    if (!winner || winner.op !== 'override') {
      winner = candidate;
      continue;
    }
    if (candidate.priority > winner.priority) {
      winner = candidate;
    } else if (candidate.priority === winner.priority && candidate.id < winner.id) {
      winner = candidate;
    }
  }
  return winner;
}

export function evaluateSnapshot(input: EvaluationInput): EvaluationSnapshot {
  const { rules, sources, modifiers } = input;
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  if (ruleById.size !== rules.length) {
    throw new EvaluationError('存在重复定义的属性规则');
  }
  const modifiersByAttribute = new Map<AttributeId, Modifier[]>();
  for (const modifier of modifiers) {
    if (!ruleById.has(modifier.attribute)) {
      throw new EvaluationError(`修正 ${modifier.id} 引用了未声明的属性 ${modifier.attribute}`);
    }
    const list = modifiersByAttribute.get(modifier.attribute) ?? [];
    list.push(modifier);
    modifiersByAttribute.set(modifier.attribute, list);
  }

  const edges = dependencyEdges(sources, modifiers);
  const order = evaluationOrder(rules, edges);
  const labels = sourceLabels(sources);

  const valueByAttribute = new Map<AttributeId, number>();
  const preClampByAttribute = new Map<AttributeId, number>();
  const explanationByAttribute = new Map<AttributeId, AttributeExplanation>();

  for (const attribute of order) {
    const rule = ruleById.get(attribute)!;
    const attributeModifiers = modifiersByAttribute.get(attribute) ?? [];
    const buckets = bucketize(attributeModifiers);

    const overrides = buckets.override;
    const overrideWinner = winnerOverride(overrides);
    const overrideLosers = new Set(
      overrides
        .filter((modifier) => modifier !== overrideWinner)
        .map((modifier) => modifier.id),
    );

    const appliedByModifier = new Map<string, number>();
    const shadowedByModifier = new Set<string>();
    const dependencyByModifier = new Map<string, DependencyValue[]>();
    for (const modifier of attributeModifiers) {
      appliedByModifier.set(modifier.id, 0);
      if (modifier.op === 'derive') {
        const dependency = modifier.dependsOn[0]!;
        const dependencyValue = valueByAttribute.get(dependency);
        if (dependencyValue === undefined) {
          throw new EvaluationError(
            `属性 ${attribute} 的派生修正 ${modifier.id} 依赖 ${dependency}，但后者尚未求值`,
          );
        }
        dependencyByModifier.set(modifier.id, [
          { attribute: dependency, value: dependencyValue, modifierId: modifier.id },
        ]);
      }
    }

    const steps: StepTrace[] = [];
    let accumulated = 0;

    const pushStep = (step: StepTrace['step'], inputValue: number, outputValue: number, aggregate: number | null, applied: boolean): void => {
      steps.push({
        step,
        inputValue: normalizeZero(inputValue, rule.precision),
        outputValue: normalizeZero(outputValue, rule.precision),
        delta: normalizeZero(outputValue - inputValue, rule.precision),
        aggregate,
        applied,
      });
    };

    for (const step of rule.pipeline) {
      if (step === 'clamp') continue;
      const inputValue = accumulated;
      let outputValue = accumulated;
      let aggregate: number | null = null;
      let applied = false;

      switch (step) {
        case 'addBase':
        case 'addFlat': {
          const bucket = step === 'addBase' ? buckets.base : buckets.flat;
          if (bucket.length > 0) {
            const sum = bucket.reduce((total, modifier) => total + modifier.value, 0);
            aggregate = roundTo(sum, rule.precision);
            for (const modifier of bucket) {
              appliedByModifier.set(modifier.id, roundTo(modifier.value, rule.precision));
            }
            outputValue = accumulated + sum;
            applied = true;
          }
          break;
        }
        case 'multiplyPercent': {
          if (buckets.percent.length > 0) {
            const ratioSum = buckets.percent.reduce((total, modifier) => total + modifier.value, 0);
            aggregate = roundTo(ratioSum, rule.precision + 4);
            for (const modifier of buckets.percent) {
              // 加法叠加的百分比：每条修正的贡献可精确拆分为 基准值 × 该条比率。
              appliedByModifier.set(modifier.id, roundTo(accumulated * modifier.value, rule.precision));
            }
            outputValue = accumulated * (1 + ratioSum);
            applied = true;
          }
          break;
        }
        case 'addDerived': {
          if (buckets.derive.length > 0) {
            const sum = buckets.derive.reduce((total, modifier) => {
              if (modifier.op !== 'derive') return total;
              const dependencyValue = dependencyByModifier.get(modifier.id)?.[0]?.value ?? 0;
              return total + dependencyValue * modifier.value + modifier.offset;
            }, 0);
            aggregate = roundTo(sum, rule.precision);
            for (const modifier of buckets.derive) {
              if (modifier.op !== 'derive') continue;
              const dependencyValue = dependencyByModifier.get(modifier.id)?.[0]?.value ?? 0;
              appliedByModifier.set(
                modifier.id,
                roundTo(dependencyValue * modifier.value + modifier.offset, rule.precision),
              );
            }
            outputValue = accumulated + sum;
            applied = true;
          }
          break;
        }
        case 'applyOverride': {
          if (overrideWinner) {
            const winnerValue = overrideWinner.value;
            aggregate = roundTo(winnerValue, rule.precision);
            appliedByModifier.set(
              overrideWinner.id,
              roundTo(winnerValue - accumulated, rule.precision),
            );
            for (const loser of overrideLosers) shadowedByModifier.add(loser);
            outputValue = winnerValue;
            applied = true;
          }
          break;
        }
        default: {
          const exhaustive: never = step;
          throw new EvaluationError(`未知求值步骤 ${String(exhaustive)}`);
        }
      }

      accumulated = roundTo(outputValue, rule.precision);
      pushStep(step, inputValue, accumulated, aggregate, applied);
    }

    const preClamp = accumulated;
    const clamped = Math.min(rule.clamp.max, Math.max(rule.clamp.min, preClamp));
    const finalValue = normalizeZero(roundTo(clamped, rule.precision), rule.precision);
    pushStep('clamp', preClamp, finalValue, null, finalValue !== preClamp);

    const contributions: ContributionView[] = attributeModifiers.map((modifier) => {
      const source = labels.get(modifier.sourceId);
      const shadowed = shadowedByModifier.has(modifier.id);
      let rawValue = modifier.value;
      let note = '';
      if (modifier.op === 'derive') {
        const dependencies = dependencyByModifier.get(modifier.id) ?? [];
        const base = dependencies[0]?.value ?? 0;
        rawValue = roundTo(base * modifier.value + modifier.offset, rule.precision);
        note = `${dependencies.map((entry) => `${entry.attribute}=${entry.value}`).join(', ')} × ${modifier.value} ${formatSigned(modifier.offset, rule.precision)}`;
      } else if (modifier.op === 'percent') {
        rawValue = modifier.value;
        note = `${(modifier.value * 100).toFixed(2)}%`;
      } else if (modifier.op === 'override') {
        rawValue = modifier.value;
        note = shadowed ? `被 ${overrideWinner?.id ?? '更高优先级覆盖'} 覆盖` : '覆盖胜出';
      }
      return {
        modifierId: modifier.id,
        sourceId: modifier.sourceId,
        sourceKind: source?.kind ?? 'derived',
        sourceLabel: source?.label ?? modifier.sourceId,
        attribute: modifier.attribute,
        op: modifier.op,
        rawValue: normalizeZero(roundTo(rawValue, rule.precision), rule.precision),
        appliedValue: shadowed ? 0 : normalizeZero(roundTo(appliedByModifier.get(modifier.id) ?? 0, rule.precision), rule.precision),
        shadowed,
        dependency: dependencyByModifier.get(modifier.id)?.[0] ?? null,
        note,
      };
    });

    const dependencies: DependencyValue[] = [];
    for (const modifier of buckets.derive) {
      dependencies.push(...(dependencyByModifier.get(modifier.id) ?? []));
    }

    const explanation: AttributeExplanation = {
      attribute,
      label: rule.label,
      description: rule.description,
      precision: rule.precision,
      revision: input.revision ?? 0,
      tick: input.tick ?? 0,
      finalValue,
      preClampValue: normalizeZero(roundTo(preClamp, rule.precision), rule.precision),
      clamp: {
        min: rule.clamp.min,
        max: rule.clamp.max,
        clamped: finalValue !== normalizeZero(roundTo(preClamp, rule.precision), rule.precision),
      },
      steps,
      contributions,
      dependencies,
    };

    valueByAttribute.set(attribute, finalValue);
    preClampByAttribute.set(attribute, explanation.preClampValue);
    explanationByAttribute.set(attribute, explanation);
  }

  return {
    valueByAttribute,
    preClampByAttribute,
    explanationByAttribute,
    edges,
    evaluationOrder: order,
  };
}

