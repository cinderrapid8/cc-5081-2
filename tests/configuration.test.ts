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
import { AttributeService } from '../src/core/service.js';
import type { ConfigurationCandidate, Modifier, PipelineStep } from '../src/core/types.js';

const PLAYER_BASE = source('char.base', 'base', '角色基础');

const attackRule = rule('attack', { precision: 3, clamp: { min: 0, max: 100000 } });
const shieldRule = rule('shieldCapacity', { precision: 3 });
const maxHpRule = rule('maxHp', { precision: 3 });

const baselineModifiers: Modifier[] = [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)];
const derivedSource = source('sys.derived', 'derived', '派生换算');

function baseline() {
  return service({
    rules: [attackRule, maxHpRule, shieldRule],
    base: {
      source: PLAYER_BASE,
      modifiers: [...baselineModifiers, baseMod('base.maxHp', PLAYER_BASE.id, 'maxHp', 500)],
    },
    system: {
      sources: [derivedSource],
      modifiers: [deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp')],
    },
    loadouts: [
      {
        id: 'none',
        label: '空负载',
        description: '',
        sources: [],
        modifiers: [],
      },
    ],
  });
}

function candidate(overrides: Partial<ConfigurationCandidate>): ConfigurationCandidate {
  const svc = baseline();
  const graph = svc.getDependencyGraph();
  void graph;
  return {
    rules: [attackRule, maxHpRule, shieldRule],
    sources: [derivedSource],
    modifiers: [deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp')],
    ...overrides,
  };
}

describe('整图配置检查', () => {
  it('合法候选可应用，并提升 revision', () => {
    const svc = baseline();
    const beforeRevision = svc.getState().revision;
    const next = candidate({
      rules: [attackRule, maxHpRule, shieldRule],
      modifiers: [
        deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.4, 0, 'maxHp'),
      ],
    });
    const report = svc.validateConfiguration(next);
    assert.equal(report.ok, true);
    const result = svc.applyConfiguration(next);
    assert.equal(result.accepted, true);
    assert.equal(svc.getState().revision, beforeRevision + 1);
    assert.equal(svc.getValue('shieldCapacity'), 200);
  });

  it('缺失依赖会阻止应用，旧状态保持可算', () => {
    const svc = baseline();
    const before = svc.getValues(['attack', 'maxHp', 'shieldCapacity']);
    const beforeRevision = svc.getState().revision;

    const missingDependency = candidate({
      rules: [attackRule, shieldRule],
      modifiers: [deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp')],
    });
    const report = svc.validateConfiguration(missingDependency);
    assert.equal(report.ok, false);
    const issue = report.issues.find((entry) => entry.code === 'missing-dependency');
    assert.ok(issue);
    assert.deepEqual(issue.attributes, ['maxHp']);
    assert.match(issue.message, /maxHp/);

    const result = svc.applyConfiguration(missingDependency);
    assert.equal(result.accepted, false);
    assert.equal(svc.getState().revision, beforeRevision);
    assert.deepEqual(svc.getValues(['attack', 'maxHp', 'shieldCapacity']), before);
    assert.equal(svc.explain('shieldCapacity').revision, beforeRevision);
  });

  it('循环定义被拒绝并指出参与节点', () => {
    const svc = baseline();
    const cyclic = candidate({
      rules: [attackRule, maxHpRule, shieldRule],
      modifiers: [
        deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp'),
        deriveMod('derive.hp', derivedSource.id, 'maxHp', 0.1, 0, 'shieldCapacity'),
      ],
    });
    const result = svc.applyConfiguration(cyclic);
    assert.equal(result.accepted, false);
    const cycle = result.report.issues.find((issue) => issue.code === 'dependency-cycle');
    assert.deepEqual([...(cycle?.attributes ?? [])].sort(), ['maxHp', 'shieldCapacity']);
  });

  it('规则漏掉百分比步骤时，未被消费的修正会被报出', () => {
    const svc = baseline();
    const rulesWithMissingStep = [
      { ...attackRule, pipeline: ['addBase', 'addFlat', 'clamp'] as readonly PipelineStep[] },
      maxHpRule,
      shieldRule,
    ];
    const next = candidate({
      rules: rulesWithMissingStep,
      modifiers: [
        deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp'),
        percentMod('cfg.percent', derivedSource.id, 'attack', 0.5),
      ],
    });
    const report = svc.validateConfiguration(next);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === 'unconsumed-modifier'));
  });

  it('来源类型不允许的算子被拒绝', () => {
    const svc = baseline();
    const badKind = candidate({
      sources: [source('bad.base', 'derived', '派生来源')],
      modifiers: [flatMod('bad.flat', 'bad.base', 'attack', 20)],
    });
    const report = svc.validateConfiguration(badKind);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === 'invalid-source-kind'));
  });

  it('来源重复导致身份歧义时被拒绝', () => {
    const svc = baseline();
    const duplicate = candidate({
      sources: [derivedSource, derivedSource],
    });
    const report = svc.validateConfiguration(duplicate);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === 'duplicate-source'));
  });

  it('拒绝应用后再次应用合法配置仍然可用', () => {
    const svc = baseline();
    const broken = candidate({
      modifiers: [deriveMod('derive.shield', 'sys.missing', 'shieldCapacity', 0.2, 5, 'maxHp')],
      sources: [],
    });
    assert.equal(svc.applyConfiguration(broken).accepted, false);
    const fixed = candidate({
      rules: [attackRule, maxHpRule, shieldRule],
      modifiers: [],
    });
    assert.equal(svc.applyConfiguration(fixed).accepted, true);
    assert.equal(svc.getValue('shieldCapacity'), 0);
  });
});

describe('配置替换与运行状态', () => {
  it('批量替换保留活动效果与负载，只替换系统来源', () => {
    const svc = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: baselineModifiers },
      loadouts: [
        {
          id: 'gear',
          label: '装备',
          description: '',
          sources: [source('eq.blade', 'equipment', '短刃')],
          modifiers: [flatMod('eq.attack', 'eq.blade', 'attack', 30)],
        },
      ],
      effects: [
        {
          id: 'tpl.rage',
          label: '狂怒',
          description: '',
          kind: 'buff',
          durationTicks: 4,
          modifiers: [flatMod('tpl.rage.attack', 'tpl.rage', 'attack', 20)],
        },
      ],
    });
    svc.activateEffect('tpl.rage');
    assert.equal(svc.getValue('attack'), 150);

    const result = svc.applyConfiguration({
      rules: [attackRule],
      sources: [],
      modifiers: [],
    });
    assert.equal(result.accepted, true);
    assert.equal(svc.getValue('attack'), 150, '装备与效果仍然在册');
    assert.equal(svc.getState().loadoutId, 'gear');
    assert.equal(svc.listActiveEffects().length, 1);
  });

  it('新规则集合缺少被活动效果引用的属性时拒绝替换', () => {
    const svc = service({
      rules: [attackRule, maxHpRule],
      base: {
        source: PLAYER_BASE,
        modifiers: [...baselineModifiers, baseMod('base.maxHp', PLAYER_BASE.id, 'maxHp', 500)],
      },
      effects: [
        {
          id: 'tpl.fortify',
          label: '壁垒',
          description: '',
          kind: 'buff',
          durationTicks: 4,
          modifiers: [flatMod('tpl.fortify.maxHp', 'tpl.fortify', 'maxHp', 100)],
        },
      ],
    });
    svc.activateEffect('tpl.fortify');
    const result = svc.applyConfiguration({
      rules: [attackRule],
      sources: [],
      modifiers: [],
    });
    assert.equal(result.accepted, false);
    assert.ok(result.report.issues.some((issue) => issue.code === 'unknown-attribute'));
    assert.equal(svc.getValue('maxHp'), 600);
  });
});

describe('查询接口', () => {
  it('getValues 只返回请求的属性并冻结结果', () => {
    const svc = baseline();
    const values = svc.getValues(['attack', 'maxHp']);
    assert.deepEqual(values, { attack: 100, maxHp: 500 });
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => svc.getValues(['missing']), /未知属性/);
    assert.throws(() => svc.getValue('missing'), /未知属性/);
  });

  it('解释的每一项贡献之和与最终值一致（除覆盖外）', () => {
    const svc = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      system: {
        sources: [source('sys.flat', 'equipment')],
        modifiers: [flatMod('sys.flat.attack', 'sys.flat', 'attack', 30)],
      },
      loadouts: [
        {
          id: 'gear',
          label: '',
          description: '',
          sources: [source('eq.pct', 'equipment')],
          modifiers: [percentMod('eq.pct.attack', 'eq.pct', 'attack', 0.2)],
        },
      ],
    });
    const explanation = svc.explain('attack');
    const additive = explanation.contributions.reduce(
      (sum, entry) => sum + (entry.op === 'flat' || entry.op === 'base' ? entry.appliedValue : 0),
      0,
    );
    assert.equal(additive, 130);
    assert.equal(explanation.finalValue, 156); // 130 × 1.2
    const percentContribution = explanation.contributions.find((entry) => entry.op === 'percent');
    assert.equal(percentContribution?.appliedValue, 26);
  });

  it('快照按 revision 更新，explain 返回与当前值一致的版本', () => {
    const svc = baseline();
    const first = svc.explain('attack');
    assert.equal(first.finalValue, 100);
    const beforeRevision = first.revision;
    svc.applyConfiguration({
      rules: [attackRule, maxHpRule, shieldRule],
      sources: [derivedSource],
      modifiers: [deriveMod('derive.shield', derivedSource.id, 'shieldCapacity', 0.2, 5, 'maxHp')],
    });
    const after = svc.explain('attack');
    assert.equal(after.revision, beforeRevision + 1);
    assert.equal(svc.getState().revision, after.revision);
  });
});
