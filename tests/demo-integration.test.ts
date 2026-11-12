import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_CATALOG } from '../src/demo/catalog.js';
import { AttributeService } from '../src/core/service.js';
import type { AttributeCatalog, ConfigurationCandidate, Modifier } from '../src/core/types.js';

function demo(): AttributeService {
  return new AttributeService(DEMO_CATALOG);
}

function cyclicCandidate(): ConfigurationCandidate {
  const modifiers: Modifier[] = DEMO_CATALOG.system.modifiers.map((modifier) =>
    modifier.op === 'derive' && modifier.id === 'derive.shieldCapacity.maxHp'
      ? { ...modifier, dependsOn: ['shieldRegen'] }
      : modifier,
  );
  return { rules: DEMO_CATALOG.rules, sources: DEMO_CATALOG.system.sources, modifiers };
}

function missingDependencyCandidate(): ConfigurationCandidate {
  return {
    rules: DEMO_CATALOG.rules.filter((rule) => rule.id !== 'shieldCapacity'),
    sources: DEMO_CATALOG.system.sources,
    modifiers: DEMO_CATALOG.system.modifiers,
  };
}

describe('演示目录集成', () => {
  it('初始状态通过整图校验并给出派生值', () => {
    const svc = demo();
    assert.equal(svc.getState().revision, 1);
    // maxHp = 820 × 1.08 = 885.6；shieldCapacity = 885.6 × 0.35 + 40 = 349.96
    assert.equal(svc.getValue('maxHp'), 885.6);
    assert.equal(svc.getValue('shieldCapacity'), 349.96);
    assert.equal(svc.getValue('shieldRegen'), 47.995);
  });

  it('多来源同刻退出只提升一次 revision', () => {
    const svc = demo();
    svc.activateEffect('effect.frenzy');
    svc.activateEffect('effect.fortify');
    svc.activateEffect('effect.stoneform');
    const before = svc.getState().revision;
    assert.equal(svc.getValue('attack'), 199.2);
    assert.equal(svc.getValue('moveSpeed'), 40);

    const report = svc.advanceTick(2);
    assert.deepEqual([...report.removedSourceIds].sort(), ['effect.frenzy#1', 'effect.stoneform#3']);
    assert.equal(report.revision, before + 1);
    assert.equal(svc.getValue('attack'), 169.32);
    assert.equal(svc.getValue('moveSpeed'), 135); // (180) × (1-0.25)
    assert.equal(svc.getValue('maxHp'), 1036.8, '壁垒仍在（tick 3 才到期；两条 flat 生效）');
  });

  it('覆盖修正竞争与来源解释读取真正求值结果', () => {
    const svc = demo();
    svc.switchLoadout('siege');
    const explanation = svc.explain('precision');
    assert.equal(explanation.finalValue, 30);
    const contributions = explanation.contributions;
    const overrideEntry = contributions.find(
      (entry) => entry.modifierId === 'siege.weather.override.precision',
    );
    assert.ok(overrideEntry);
    assert.equal(overrideEntry.shadowed, false);
    assert.equal(overrideEntry.appliedValue, -20.4); // 30 - 50.4
    assert.match(overrideEntry.note, /覆盖胜出/);

    const sourceExplanation = svc.explainSource('loadout.siege.weather');
    assert.ok(sourceExplanation);
    assert.equal(sourceExplanation.active, true);
    const overrideSourceEntry = sourceExplanation.modifiers.find(
      (entry) => entry.modifierId === 'siege.weather.override.precision',
    );
    assert.equal(overrideSourceEntry?.appliedValue, -20.4);
    assert.equal(overrideSourceEntry?.shadowed, false);
  });

  it('同值修正来自不同来源时可精确撤销', () => {
    const catalog: AttributeCatalog = {
      ...DEMO_CATALOG,
      loadouts: [
        {
          id: 'twin',
          label: '同值对照',
          description: '',
          sources: [
            { id: 'twin.alpha', kind: 'equipment', label: '短刃 α' },
            { id: 'twin.beta', kind: 'equipment', label: '短刃 β' },
          ],
          modifiers: [
            { id: 'twin.alpha.attack', sourceId: 'twin.alpha', attribute: 'attack', op: 'flat', value: 37 },
            { id: 'twin.beta.attack', sourceId: 'twin.beta', attribute: 'attack', op: 'flat', value: 37 },
          ],
        },
      ],
      initialLoadoutId: 'twin',
    };
    const svc = new AttributeService(catalog);
    assert.equal(svc.getValue('attack'), 194);
    svc.detachSource('twin.alpha');
    assert.equal(svc.getValue('attack'), 157);
    const applied = svc.explain('attack').contributions
      .filter((entry) => entry.modifierId.startsWith('twin'))
      .map((entry) => entry.modifierId);
    assert.deepEqual(applied, ['twin.beta.attack']);
  });

  it('循环与缺失依赖都被整图检查拒绝，旧状态仍可算', () => {
    const svc = demo();
    const baseline = svc.getValues(['maxHp', 'shieldCapacity', 'shieldRegen']);
    const revision = svc.getState().revision;

    const cyclic = svc.applyConfiguration(cyclicCandidate());
    assert.equal(cyclic.accepted, false);
    const cycleIssue = cyclic.report.issues.find((issue) => issue.code === 'dependency-cycle');
    assert.deepEqual([...(cycleIssue?.attributes ?? [])].sort(), ['shieldCapacity', 'shieldRegen']);

    const missing = svc.validateConfiguration(missingDependencyCandidate());
    assert.equal(missing.ok, false);
    assert.ok(missing.issues.some((issue) => issue.code === 'missing-dependency'));

    assert.equal(svc.getState().revision, revision);
    assert.deepEqual(svc.getValues(['maxHp', 'shieldCapacity', 'shieldRegen']), baseline);
    assert.equal(svc.explain('shieldCapacity').revision, revision);
  });

  it('负载切换与负倍率共同影响攻击中间值', () => {
    const svc = demo();
    assert.equal(svc.getValue('attack'), 169.32);
    const switched = svc.switchLoadout('siege');
    assert.equal(switched.accepted, true);
    assert.equal(svc.getValue('attack'), 205);
    const explanation = svc.explain('attack');
    assert.equal(explanation.preClampValue, 205);
    assert.equal(explanation.steps.find((step) => step.step === 'multiplyPercent')?.aggregate, -0.18);
    assert.equal(explanation.steps.find((step) => step.step === 'addFlat')?.outputValue, 250);
  });
});
