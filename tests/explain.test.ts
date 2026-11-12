import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_CATALOG } from '../src/demo/catalog.js';
import { AttributeService } from '../src/core/service.js';

describe('来源级解释', () => {
  it('常驻与负载来源都能被解释', () => {
    const svc = new AttributeService(DEMO_CATALOG);
    const base = svc.explainSource('character.base');
    assert.ok(base);
    assert.equal(base.active, true);
    assert.equal(base.origin, 'fixed');
    assert.equal(base.modifiers.length, 7);

    const armor = svc.explainSource('loadout.field.armor');
    assert.equal(armor?.origin, 'loadout');
    assert.equal(armor?.modifiers.find((entry) => entry.modifierId === 'field.armor.defense')?.appliedValue, 85);
  });

  it('切换负载后原负载来源不再可解释', () => {
    const svc = new AttributeService(DEMO_CATALOG);
    svc.switchLoadout('siege');
    assert.equal(svc.explainSource('loadout.field.armor'), null);
    assert.equal(svc.explainSource('loadout.siege.armor')?.origin, 'loadout');
  });

  it('效果到期后按模板可查到 inactive 记录', () => {
    const svc = new AttributeService(DEMO_CATALOG);
    svc.activateEffect('effect.frenzy');
    svc.advanceTick(2);
    assert.equal(svc.explainSource('effect.frenzy#1'), null, '实例不存在');
    const template = svc.explainSource('effect.frenzy');
    assert.equal(template?.active, false);
    assert.equal(template?.kind, 'buff');
  });

  it('被压制的覆盖在来源解释里标记 shadowed', () => {
    const svc = new AttributeService(DEMO_CATALOG);
    svc.switchLoadout('siege');
    svc.activateEffect('effect.mark');
    const mark = svc.explainSource('effect.mark#1');
    const entry = mark?.modifiers.find((modifier) => modifier.modifierId === 'mark.override.precision#1');
    assert.equal(entry?.shadowed, true);
    assert.equal(entry?.appliedValue, 0);
    assert.equal(entry?.rawValue, 88);
  });
});
