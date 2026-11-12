import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseMod,
  catalog,
  deriveMod,
  flatMod,
  overrideMod,
  percentMod,
  rule,
  service,
  source,
} from './fixtures.js';
import { AttributeService } from '../src/core/service.js';
import type { EffectTemplate, LoadoutDefinition, Modifier, SourceDefinition } from '../src/core/types.js';

const PLAYER_BASE = source('char.base', 'base', '角色基础');

const attackRule = rule('attack', { clamp: { min: 0, max: 100000 }, precision: 3 });
const hpRule = rule('maxHp', { clamp: { min: 1, max: 100000 }, precision: 3 });

function loadout(
  id: string,
  sources: SourceDefinition[],
  modifiers: Modifier[],
): LoadoutDefinition {
  return { id, label: id, description: id, sources, modifiers };
}

const A = source('eq.a', 'equipment', '装备 A');
const B = source('eq.b', 'equipment', '装备 B');

describe('来源身份与撤销', () => {
  it('数值相同的两个来源，卸下一个只撤销自己的修正', () => {
    const instance = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [
        loadout(
          'dual',
          [A, B],
          [
            flatMod('a.attack', A.id, 'attack', 25),
            flatMod('b.attack', B.id, 'attack', 25),
          ],
        ),
      ],
    });
    assert.equal(instance.getValue('attack'), 150);
    assert.equal(instance.detachSource(A.id), true);
    assert.equal(instance.getValue('attack'), 125);
    const contributions = instance.explain('attack').contributions;
    assert.deepEqual(
      contributions.filter((entry) => entry.op === 'flat').map((entry) => [entry.modifierId, entry.appliedValue]),
      [['b.attack', 25]],
    );
    assert.equal(instance.listActiveSources().some((entry) => entry.id === B.id), true);
    assert.equal(instance.listActiveSources().some((entry) => entry.id === A.id), false);
  });

  it('百分比来源撤销后只回退自己的倍率', () => {
    const instance = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [
        loadout(
          'percent-dual',
          [A, B],
          [
            percentMod('a.attack', A.id, 'attack', 0.2),
            percentMod('b.attack', B.id, 'attack', 0.2),
          ],
        ),
      ],
    });
    assert.equal(instance.getValue('attack'), 140);
    instance.detachSource(B.id);
    assert.equal(instance.getValue('attack'), 120);
    assert.equal(instance.detachSource(B.id), false, '重复卸下返回 false');
    assert.equal(instance.getValue('attack'), 120);
  });

  it('常驻系统来源不允许单独卸下', () => {
    const instance = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      system: {
        sources: [source('sys.global', 'equipment', '全局加成')],
        modifiers: [flatMod('sys.global.attack', 'sys.global', 'attack', 10)],
      },
    });
    assert.throws(() => instance.detachSource('sys.global'), /常驻系统来源/);
    assert.equal(instance.getValue('attack'), 110);
  });
});

describe('临时效果与同刻退出', () => {
  const effects: EffectTemplate[] = [
    {
      id: 'tpl.frenzy',
      label: '战意',
      description: '',
      kind: 'buff',
      durationTicks: 2,
      modifiers: [percentMod('tpl.frenzy.attack', 'tpl.frenzy', 'attack', 0.5)],
    },
    {
      id: 'tpl.fortify',
      label: '壁垒',
      description: '',
      kind: 'buff',
      durationTicks: 3,
      modifiers: [flatMod('tpl.fortify.maxHp', 'tpl.fortify', 'maxHp', 100)],
    },
    {
      id: 'tpl.stone',
      label: '化石',
      description: '',
      kind: 'buff',
      durationTicks: 2,
      modifiers: [overrideMod('tpl.stone.attack', 'tpl.stone', 'attack', 40, 5)],
    },
  ];

  function instance() {
    return service({
      rules: [attackRule, hpRule],
      base: {
        source: PLAYER_BASE,
        modifiers: [
          baseMod('base.attack', PLAYER_BASE.id, 'attack', 100),
          baseMod('base.maxHp', PLAYER_BASE.id, 'maxHp', 500),
        ],
      },
      loadouts: [loadout('none', [], [])],
      effects,
    });
  }

  it('同刻到期的多个来源一次性撤销，触发单次 revision', () => {
    const svc = instance();
    svc.activateEffect('tpl.frenzy');
    svc.activateEffect('tpl.fortify');
    svc.activateEffect('tpl.stone');
    assert.equal(svc.getValue('attack'), 40, '覆盖修正生效');
    assert.equal(svc.getValue('maxHp'), 600);

    const revisionBefore = svc.getState().revision;
    const report = svc.advanceTick(2);
    assert.deepEqual([...report.removedSourceIds].sort(), ['tpl.frenzy#1', 'tpl.stone#3']);
    assert.equal(report.revision, revisionBefore + 1);
    assert.equal(svc.getValue('attack'), 100);
    assert.equal(svc.getValue('maxHp'), 600);
    assert.equal(svc.listActiveSources().filter((entry) => entry.origin === 'runtime').length, 1);
  });

  it('到期来源的身份被释放，重新激活生成新实例', () => {
    const svc = instance();
    const first = svc.activateEffect('tpl.frenzy');
    svc.advanceTick(2);
    const second = svc.activateEffect('tpl.frenzy');
    assert.equal(first.instanceId, 'tpl.frenzy#1');
    assert.equal(second.instanceId, 'tpl.frenzy#2');
    assert.equal(svc.getValue('attack'), 150);
  });

  it('主动停用只撤销该实例', () => {
    const svc = instance();
    svc.activateEffect('tpl.frenzy');
    const fortify = svc.activateEffect('tpl.fortify');
    svc.deactivateEffect(fortify.instanceId);
    assert.equal(svc.getValue('attack'), 150);
    assert.equal(svc.getValue('maxHp'), 500);
    assert.equal(svc.deactivateEffect(fortify.instanceId), false);
  });

  it('tick 推进不影响未到期来源', () => {
    const svc = instance();
    svc.activateEffect('tpl.fortify');
    svc.advanceTick(1);
    assert.equal(svc.getValue('maxHp'), 600);
    const report = svc.advanceTick(2);
    assert.deepEqual(report.removedSourceIds, ['tpl.fortify#1']);
    assert.equal(svc.getValue('maxHp'), 500);
  });
});

describe('覆盖修正竞争', () => {
  const priorityLow = overrideMod('rel.low', 'src.low', 'attack', 30, 1);
  const priorityHigh = overrideMod('rel.high', 'src.high', 'attack', 80, 9);

  function instance() {
    return service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [
        loadout(
          'overrides',
          [source('src.low', 'equipment', '低优先'), source('src.high', 'equipment', '高优先')],
          [priorityLow, priorityHigh],
        ),
      ],
    });
  }

  it('高优先级覆盖胜出，低优先级被标记压制且贡献为 0', () => {
    const svc = instance();
    assert.equal(svc.getValue('attack'), 80);
    const contributions = svc.explain('attack').contributions;
    const low = contributions.find((entry) => entry.modifierId === 'rel.low');
    const high = contributions.find((entry) => entry.modifierId === 'rel.high');
    assert.equal(low?.shadowed, true);
    assert.equal(low?.appliedValue, 0);
    assert.equal(high?.shadowed, false);
    assert.equal(high?.appliedValue, -20); // 覆盖把 100 替换为 80
    assert.match(high?.note ?? '', /覆盖胜出/);
    const step = svc.explain('attack').steps.find((entry) => entry.step === 'applyOverride');
    assert.equal(step?.aggregate, 80);
  });

  it('卸下胜出覆盖来源后，被压制的低优先级覆盖接管', () => {
    const svc = instance();
    svc.detachSource('src.high');
    assert.equal(svc.getValue('attack'), 30);
    const contributions = svc.explain('attack').contributions;
    assert.equal(contributions.find((entry) => entry.modifierId === 'rel.low')?.shadowed, false);
  });

  it('优先级相同按修正 id 稳定决胜', () => {
    const samePriority = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [
        loadout(
          'same-priority',
          [source('src.x', 'equipment'), source('src.y', 'equipment')],
          [
            overrideMod('override.x', 'src.x', 'attack', 60, 5),
            overrideMod('override.y', 'src.y', 'attack', 70, 5),
          ],
        ),
      ],
    });
    // id 字典序小者胜出。
    assert.equal(samePriority.getValue('attack'), 60);
  });
});

describe('负载切换', () => {
  const field = loadout(
    'field',
    [source('field.blade', 'equipment', '短刃')],
    [flatMod('field.attack', 'field.blade', 'attack', 40)],
  );
  const siege = loadout(
    'siege',
    [source('siege.hammer', 'equipment', '攻城锤'), source('siege.storm', 'pressure', '沙暴')],
    [
      flatMod('siege.attack.flat', 'siege.hammer', 'attack', 120),
      percentMod('siege.attack.percent', 'siege.hammer', 'attack', -0.2),
      percentMod('siege.storm.attack', 'siege.storm', 'attack', -0.1),
    ],
  );

  function instance() {
    return service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [field, siege],
    });
  }

  it('切换负载后旧装备来源全部消失，新装备来源参与求值', () => {
    const svc = instance();
    assert.equal(svc.getValue('attack'), 140);
    const result = svc.switchLoadout('siege');
    assert.equal(result.accepted, true);
    assert.deepEqual(svc.getValues(['attack']), { attack: 154 }); // (100+120) × (1-0.2-0.1)
    assert.equal(svc.listActiveSources().some((entry) => entry.id === 'field.blade'), false);
    assert.equal(svc.listActiveSources().some((entry) => entry.id === 'siege.storm'), true);
    assert.equal(svc.getState().loadoutLabel, 'siege');
  });

  it('未知负载被拒绝且不改变状态', () => {
    const svc = instance();
    const result = svc.switchLoadout('missing');
    assert.equal(result.accepted, false);
    assert.equal(svc.getState().loadoutId, 'field');
  });

  it('活动效果在负载切换后仍然保留', () => {
    const withEffect = service({
      rules: [attackRule],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.attack', PLAYER_BASE.id, 'attack', 100)] },
      loadouts: [field, siege],
      effects: [
        {
          id: 'tpl.rage',
          label: '狂怒',
          description: '',
          kind: 'buff',
          durationTicks: 5,
          modifiers: [flatMod('tpl.rage.attack', 'tpl.rage', 'attack', 25)],
        },
      ],
    });
    withEffect.activateEffect('tpl.rage');
    assert.equal(withEffect.getValue('attack'), 165);
    withEffect.switchLoadout('siege');
    assert.equal(withEffect.getValue('attack'), 171.5); // (100+120+25) × 0.7
    assert.equal(withEffect.listActiveSources().some((entry) => entry.id === 'tpl.rage#1'), true);
  });
});

describe('派生与临时来源的交互', () => {
  it('卸下提供派生基数的来源后，依赖属性重新求值', () => {
    const hpSource = source('eq.hp', 'equipment', '护甲');
    const shieldSource = source('sys.shield', 'derived', '换算');
    const svc = service({
      rules: [hpRule, rule('shieldCapacity', { precision: 3 })],
      base: { source: PLAYER_BASE, modifiers: [baseMod('base.maxHp', PLAYER_BASE.id, 'maxHp', 100)] },
      system: {
        sources: [shieldSource],
        modifiers: [deriveMod('derive.shield', shieldSource.id, 'shieldCapacity', 0.5, 10, 'maxHp')],
      },
      loadouts: [loadout('hp', [hpSource], [flatMod('eq.hp.maxHp', hpSource.id, 'maxHp', 100)])],
    });
    assert.equal(svc.getValue('maxHp'), 200);
    assert.equal(svc.getValue('shieldCapacity'), 110);
    svc.detachSource(hpSource.id);
    assert.equal(svc.getValue('maxHp'), 100);
    assert.equal(svc.getValue('shieldCapacity'), 60);
  });
});
