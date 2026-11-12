import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseMod,
  catalog,
  deriveMod,
  flatMod,
  percentMod,
  rule,
  service,
  source,
} from './fixtures.js';
import { AttributeService, ConfigurationRejectedError } from '../src/core/service.js';
import type { PipelineStep } from '../src/core/types.js';

const PLAYER_BASE = source('char.base', 'base', '角色基础');

interface SharedModifierSetup {
  readonly system?: { sources: ReturnType<typeof source>[]; modifiers: ReturnType<typeof flatMod>[] };
}

function withFlatAndPercent(pipeline: readonly PipelineStep[], clampMax = 99999) {
  return service({
    rules: [rule('power', { pipeline, clamp: { min: 0, max: clampMax }, precision: 3 })],
    base: { source: PLAYER_BASE, modifiers: [baseMod('base.power', PLAYER_BASE.id, 'power', 100)] },
    system: {
      sources: [source('sys.flat', 'equipment', '固定加成')],
      modifiers: [flatMod('sys.flat.power', 'sys.flat', 'power', 50)],
    },
    loadouts: [
      {
        id: 'loadout',
        label: '百分比载荷',
        description: '同一套修正，不用顺序',
        sources: [source('eq.percent', 'equipment', '百分比装备')],
        modifiers: [percentMod('eq.percent.power', 'eq.percent', 'power', 0.5)],
      },
    ],
  });
}

function catchReport(build: () => unknown): ConfigurationRejectedError {
  try {
    build();
  } catch (error) {
    assert.ok(error instanceof ConfigurationRejectedError, `期望 ConfigurationRejectedError，实际 ${String(error)}`);
    return error;
  }
  assert.fail('期望抛出 ConfigurationRejectedError');
}

describe('规则驱动的求值顺序', () => {
  it('固定加值在百分比之前与之后结果不同', () => {
    const before = withFlatAndPercent(['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp']);
    assert.equal(before.getValue('power'), 225); // (100 + 50) × 1.5

    const after = withFlatAndPercent(['addBase', 'multiplyPercent', 'addFlat', 'addDerived', 'applyOverride', 'clamp']);
    assert.equal(after.getValue('power'), 200); // 100 × 1.5 + 50
  });

  it('中间值按规则顺序记录在解释里', () => {
    const instance = withFlatAndPercent(['addBase', 'multiplyPercent', 'addFlat', 'addDerived', 'applyOverride', 'clamp']);
    const explanation = instance.explain('power');
    assert.deepEqual(
      explanation.steps.map((step) => step.step),
      ['addBase', 'multiplyPercent', 'addFlat', 'addDerived', 'applyOverride', 'clamp'],
    );
    assert.deepEqual(explanation.steps.map((step) => step.outputValue), [100, 150, 200, 200, 200, 200]);
    assert.deepEqual(explanation.steps.map((step) => step.aggregate), [
      100, 0.5, 50, null, null, null,
    ]);
  });

  it('钳位在最后执行，并保留钳位前数值', () => {
    const instance = withFlatAndPercent(
      ['addBase', 'multiplyPercent', 'addFlat', 'addDerived', 'applyOverride', 'clamp'],
      190,
    );
    const explanation = instance.explain('power');
    assert.equal(explanation.preClampValue, 200);
    assert.equal(explanation.finalValue, 190);
    assert.equal(explanation.clamp.clamped, true);
    assert.equal(explanation.steps.at(-1)?.step, 'clamp');
  });

  it('拒绝 clamp 不在最后的规则', () => {
    const error = catchReport(() =>
      new AttributeService(
        catalog({
          rules: [rule('power', { pipeline: ['addBase', 'clamp', 'addFlat'] as readonly PipelineStep[] })],
          base: { source: PLAYER_BASE, modifiers: [baseMod('base.power', PLAYER_BASE.id, 'power', 100)] },
        }),
      ),
    );
    assert.ok(error.report.issues.some((issue) => issue.code === 'invalid-pipeline'));
  });

  it('拒绝重复步骤的规则', () => {
    const error = catchReport(() =>
      new AttributeService(
        catalog({
          rules: [rule('power', { pipeline: ['addBase', 'addFlat', 'addFlat', 'clamp'] as readonly PipelineStep[] })],
          base: { source: PLAYER_BASE, modifiers: [baseMod('base.power', PLAYER_BASE.id, 'power', 100)] },
        }),
      ),
    );
    assert.ok(error.report.issues.some((issue) => issue.code === 'invalid-pipeline'));
  });
});

describe('派生依赖图', () => {
  const baseSpec = {
    base: { source: PLAYER_BASE, modifiers: [baseMod('base.maxHp', PLAYER_BASE.id, 'maxHp', 800)] },
  };

  it('生命上限影响护盾容量，拓扑序先 maxHp 后 shieldCapacity', () => {
    const instance = service({
      ...baseSpec,
      rules: [rule('shieldCapacity', { precision: 3 }), rule('maxHp', { precision: 3 })],
      system: {
        sources: [source('sys.derived', 'derived')],
        modifiers: [deriveMod('derive.shield', 'sys.derived', 'shieldCapacity', 0.25, 20, 'maxHp')],
      },
    });
    assert.equal(instance.getValue('shieldCapacity'), 220);
    assert.deepEqual(instance.explain('shieldCapacity').dependencies, [
      { attribute: 'maxHp', value: 800, modifierId: 'derive.shield' },
    ]);
    const graph = instance.getDependencyGraph();
    assert.deepEqual(graph.nodes, ['shieldCapacity', 'maxHp']);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.from, 'shieldCapacity');
    assert.equal(graph.edges[0]?.to, 'maxHp');
    assert.equal(graph.edges[0]?.sourceKind, 'derived');
  });

  it('多级链 maxHp → shieldCapacity → shieldRegen', () => {
    const instance = service({
      ...baseSpec,
      rules: [
        rule('shieldRegen', { precision: 3 }),
        rule('shieldCapacity', { precision: 3 }),
        rule('maxHp', { precision: 3 }),
      ],
      system: {
        sources: [source('sys.derived', 'derived')],
        modifiers: [
          deriveMod('derive.shield', 'sys.derived', 'shieldCapacity', 0.25, 20, 'maxHp'),
          deriveMod('derive.regen', 'sys.derived', 'shieldRegen', 0.1, 2, 'shieldCapacity'),
        ],
      },
    });
    assert.equal(instance.getValue('shieldCapacity'), 220);
    assert.equal(instance.getValue('shieldRegen'), 24);
  });

  it('循环定义被拒绝，并列出参与节点', () => {
    const error = catchReport(() =>
      new AttributeService(
        catalog({
          ...baseSpec,
          rules: [rule('maxHp'), rule('shieldCapacity')],
          system: {
            sources: [source('sys.derived', 'derived')],
            modifiers: [
              deriveMod('derive.shield', 'sys.derived', 'shieldCapacity', 0.25, 20, 'maxHp'),
              deriveMod('derive.hp', 'sys.derived', 'maxHp', 0.5, 0, 'shieldCapacity'),
            ],
          },
        }),
      ),
    );
    const cycle = error.report.issues.find((issue) => issue.code === 'dependency-cycle');
    assert.ok(cycle);
    assert.deepEqual([...(cycle.attributes ?? [])].sort(), ['maxHp', 'shieldCapacity']);
    assert.match(cycle.message, /参与节点/);
  });

  it('缺失依赖在构造阶段被指出', () => {
    const error = catchReport(() =>
      new AttributeService(
        catalog({
          ...baseSpec,
          rules: [rule('shieldCapacity')],
          system: {
            sources: [source('sys.derived', 'derived')],
            modifiers: [deriveMod('derive.shield', 'sys.derived', 'shieldCapacity', 0.25, 20, 'maxHp')],
          },
        }),
      ),
    );
    assert.ok(error.report.issues.some((issue) => issue.code === 'missing-dependency'));
  });

  it('三节点循环被拒绝，并指出全部参与节点', () => {
    const error = catchReport(() =>
      new AttributeService(
        catalog({
          rules: [rule('a'), rule('b'), rule('c')],
          base: { source: PLAYER_BASE, modifiers: [] },
          system: {
            sources: [source('sys.derived', 'derived')],
            modifiers: [
              deriveMod('d.a', 'sys.derived', 'a', 0.1, 0, 'b'),
              deriveMod('d.b', 'sys.derived', 'b', 0.1, 0, 'c'),
              deriveMod('d.c', 'sys.derived', 'c', 0.1, 0, 'a'),
            ],
          },
        }),
      ),
    );
    const cycle = error.report.issues.find((issue) => issue.code === 'dependency-cycle');
    assert.deepEqual([...(cycle?.attributes ?? [])].sort(), ['a', 'b', 'c']);
  });
});
