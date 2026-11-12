import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleVersionManager } from '../../src/rule-service/version-manager.js';
import { runStartupProbe } from '../../src/rule-service/probe.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

async function loadJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(repoRoot, relative), 'utf8'));
}

async function boot(relative = 'rules/v1/rules.json') {
  const doc = await loadJson(relative);
  const { manager, report } = RuleVersionManager.bootstrap(doc);
  assert.equal(report.ok, true);
  assert.ok(manager);
  return manager;
}

describe('规则版本管理器：隔离校验与原子切换', () => {
  it('引导 v1 后能求值出非空属性表', async () => {
    const manager = await boot();
    assert.equal(manager.activeVersion, 'v1');
    assert.ok(manager.attributeService.listAttributes().length > 0);
  });

  it('循环依赖候选失败，活动版本与数值保持不变', async () => {
    const cyclic = await loadJson('deploy/candidates/cyclic.json');
    const manager = await boot();
    const before = manager.attributeService.getValues(['maxHp', 'shieldCapacity']);

    const checked = manager.validateCandidate(cyclic);
    assert.equal(checked.ok, false);
    assert.ok(checked.report.issues.some((i) => i.code === 'dependency-cycle'));

    const adoption = manager.adopt(cyclic);
    assert.equal(adoption.ok, false);
    assert.equal(manager.activeVersion, 'v1');
    assert.deepEqual(manager.attributeService.getValues(['maxHp', 'shieldCapacity']), before);
  });

  it('未知运算符候选失败，活动角色继续使用已确认规则集', async () => {
    const bad = await loadJson('deploy/candidates/unknown-operator.json');
    const manager = await boot();
    const adoption = manager.adopt(bad);
    assert.equal(adoption.ok, false);
    assert.ok(adoption.report.issues.some((i) => i.code === 'unknown-operator'));
    assert.equal(manager.activeVersion, 'v1');
    assert.ok(Number.isFinite(manager.attributeService.getValue('attack')));
  });

  it('合法 v2 候选被采用，派生换算随之改变', async () => {
    const v2 = await loadJson('rules/v2/rules.json');
    const manager = await boot();
    const v1Shield = manager.attributeService.getValue('shieldCapacity');

    const adoption = manager.adopt(v2);
    assert.equal(adoption.ok, true);
    assert.equal(manager.activeVersion, 'v2');
    // v2 换算系数 0.40 + 25，与 v1 的 0.35 + 40 必然不同。
    const v2Shield = manager.attributeService.getValue('shieldCapacity');
    const maxHp = manager.attributeService.getValue('maxHp');
    assert.notEqual(v1Shield, v2Shield);
    assert.equal(v2Shield, Math.round((maxHp * 0.4 + 25) * 1000) / 1000);
  });

  it('被拒绝后仍可成功采用合法版本', async () => {
    const v2 = await loadJson('rules/v2/rules.json');
    const bad = await loadJson('deploy/candidates/cyclic.json');
    const manager = await boot();
    assert.equal(manager.adopt(bad).ok, false);
    assert.equal(manager.adopt(v2).ok, true);
    assert.equal(manager.activeVersion, 'v2');
  });

  it('空规则集引导失败，绝不发布空属性表', () => {
    const empty = {
      version: 'empty',
      label: 'empty',
      initialLoadoutId: 'L',
      rules: [],
      character: {
        id: 'c',
        name: 'c',
        baseSource: { id: 'b', kind: 'base', label: 'b' },
        baseModifiers: [],
      },
      system: { sources: [], modifiers: [] },
      loadouts: [{ id: 'L', label: 'L', description: '', sources: [], modifiers: [] }],
      effects: [],
    };
    const { manager, report } = RuleVersionManager.bootstrap(empty);
    assert.equal(manager, null);
    assert.equal(report.ok, false);
  });
});

describe('启动探针：真实装卸两组配置并核对派生数值', () => {
  it('v1 探针全部通过', async () => {
    const manager = await boot();
    const report = runStartupProbe(manager.attributeService, manager.activeBundle);
    assert.equal(report.passed, true, report.checks.filter((c) => !c.passed).map((c) => `${c.name}:${c.detail}`).join('|'));
    assert.ok(report.checks.length >= 8);
  });

  it('v2 探针基于自身换算公式通过（不硬编码系数）', async () => {
    const manager = await boot('rules/v2/rules.json');
    const report = runStartupProbe(manager.attributeService, manager.activeBundle);
    assert.equal(report.passed, true);
    assert.equal(report.version, 'v2');
  });

  it('负载不足两组时探针失败而非误判通过', () => {
    const single = {
      version: 'solo',
      label: 'solo',
      initialLoadoutId: 'only',
      rules: [
        { id: 'a', label: 'a', description: '', pipeline: ['addBase', 'clamp'], clamp: { min: 0, max: 9 }, precision: 0 },
      ],
      character: {
        id: 'c',
        name: 'c',
        baseSource: { id: 'b', kind: 'base', label: 'b' },
        baseModifiers: [{ id: 'm', sourceId: 'b', attribute: 'a', op: 'base', value: 1 }],
      },
      system: { sources: [], modifiers: [] },
      loadouts: [{ id: 'only', label: 'only', description: '', sources: [], modifiers: [] }],
      effects: [],
    };
    const { manager, report } = RuleVersionManager.bootstrap(single);
    assert.ok(manager);
    const probeReport = runStartupProbe(manager.attributeService, manager.activeBundle);
    assert.equal(probeReport.passed, false);
    assert.ok(probeReport.checks[0]!.name === 'probe-requires-two-loadouts');
  });
});
