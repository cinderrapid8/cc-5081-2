/**
 * 演示用时间线编排。所有输入都刻意覆盖题目要求：
 * - 互相覆盖的修正（precision 上有两条 override）
 * - 负倍率（暴雨/沙暴对 attack、moveSpeed）
 * - 缺失依赖（v 版本把 shieldCapacity 抽走，仍被 shieldRegen 依赖）
 * - 循环定义（v 版本把 shieldCapacity 改成依赖 shieldRegen）
 * - 多来源同刻退出（frenzy 与 stoneform 都恰好在 tick 3 到期）
 * - 装备卸下后不误删其他来源（战意与毒刃同为 attack +flat）
 */
import type {
  AttributeCatalog,
  ConfigurationCandidate,
  Modifier,
} from '../core/types.js';
import { DEMO_CATALOG } from './catalog.js';
import { AttributeService } from '../core/service.js';
import { formatNumber, formatSigned } from '../core/numeric.js';
import { STEP_TO_OPERATOR } from '../core/validate.js';

export interface ScenarioReport {
  readonly title: string;
  readonly lines: readonly string[];
}

const catalog: AttributeCatalog = DEMO_CATALOG;

function newService(): AttributeService {
  return new AttributeService(catalog);
}

function block(title: string, body: readonly string[]): ScenarioReport {
  return { title, lines: body };
}

function stepSummary(
  service: AttributeService,
  attribute: string,
): string[] {
  const explanation = service.explain(attribute);
  const lines = [
    `属性 ${explanation.label}（${attribute}）：最终 ${formatNumber(explanation.finalValue)}，钳位前 ${formatNumber(explanation.preClampValue)}${explanation.clamp.clamped ? '（已钳位）' : ''}`,
  ];
  for (const step of explanation.steps) {
    const aggregate = step.aggregate === null ? '' : ` 桶=${formatNumber(step.aggregate, 6)}`;
    lines.push(
      `  ${step.step.padEnd(15)} ${formatNumber(step.inputValue)} → ${formatNumber(step.outputValue)} (Δ${formatSigned(step.delta)})${aggregate}`,
    );
  }
  for (const contribution of explanation.contributions) {
    const suppressed = contribution.shadowed ? ' [被覆盖]' : '';
    lines.push(
      `  来源 ${contribution.sourceLabel}（${contribution.sourceKind}）修正 ${contribution.modifierId}: 录入 ${formatNumber(contribution.rawValue)}，实际贡献 ${formatSigned(contribution.appliedValue)}${suppressed}`,
    );
  }
  return lines;
}

function candidateTweaks(): { validMissingDependency: ConfigurationCandidate; cyclic: ConfigurationCandidate; breakingRule: ConfigurationCandidate } {
  const rulesWithoutCap = catalog.rules.filter((rule) => rule.id !== 'shieldCapacity');
  const derivedNeedingCap = catalog.system.modifiers;
  const validMissingDependency: ConfigurationCandidate = {
    rules: rulesWithoutCap,
    sources: catalog.system.sources,
    modifiers: derivedNeedingCap,
  };

  const cyclicRules = catalog.rules.map((rule) => ({ ...rule }));
  const cyclicModifiers: Modifier[] = catalog.system.modifiers.map((modifier) => {
    if (modifier.op === 'derive' && modifier.id === 'derive.shieldCapacity.maxHp') {
      return { ...modifier, dependsOn: ['shieldRegen'] };
    }
    return modifier;
  });
  const cyclic: ConfigurationCandidate = {
    rules: cyclicRules,
    sources: catalog.system.sources,
    modifiers: cyclicModifiers,
  };

  const brokenRules = catalog.rules.map((rule) =>
    rule.id === 'attack'
      ? { ...rule, pipeline: ['addBase', 'addFlat', 'addDerived', 'applyOverride', 'clamp'] as const }
      : rule,
  );
  const breakingRule: ConfigurationCandidate = {
    rules: brokenRules,
    sources: catalog.system.sources,
    modifiers: catalog.system.modifiers,
  };

  return { validMissingDependency, cyclic, breakingRule };
}

export function runScenarios(): readonly ScenarioReport[] {
  const reports: ScenarioReport[] = [];

  // 1. 基础求值与派生依赖
  {
    const service = newService();
    const lines: string[] = [];
    const state = service.getState();
    lines.push(`初始负载 ${state.loadoutLabel}；revision=${state.revision}`);
    const order = service.explain('shieldRegen');
    lines.push(`求值拓扑序：${service.getDependencyGraph().nodes.join(' → ')}`);
    lines.push(`护盾再生依赖：${order.dependencies.map((entry) => `${entry.attribute}=${formatNumber(entry.value)}`).join(', ')}`);
    lines.push(...stepSummary(service, 'maxHp'));
    lines.push(...stepSummary(service, 'shieldCapacity'));
    lines.push(...stepSummary(service, 'shieldRegen'));
    reports.push(block('1. 基础数值、装备修正与派生链（野外载荷）', lines));
  }

  // 2. 负载切换：面板读取真正的求值结果
  {
    const service = newService();
    const before = service.getValue('attack');
    const switchResult = service.switchLoadout('siege');
    const after = service.getValue('attack');
    const lines: string[] = [];
    lines.push(`切换前攻击=${formatNumber(before)}；切换结果 accepted=${switchResult.accepted}，revision=${switchResult.revision}`);
    lines.push(`切换后攻击=${formatNumber(after)}，负载=${service.getState().loadoutLabel}`);
    lines.push(...stepSummary(service, 'attack'));
    lines.push(...stepSummary(service, 'precision'));
    reports.push(block('2. 负载切换与覆盖修正竞争（攻坚载荷）', lines));
  }

  // 3. 负倍率与临时增益的叠加
  {
    const service = newService();
    service.activateEffect('effect.frenzy');
    const lines: string[] = [];
    lines.push(...stepSummary(service, 'attack'));
    lines.push(`来源解释 frenzy：${JSON.stringify(service.explainSource('effect.frenzy#1')?.modifiers ?? [], null, 2)}`);
    reports.push(block('3. 负倍率 + 临时增益（战意激涌）的中间值', lines));
  }

  // 4. 同刻多来源退出 + 只撤销对应来源
  {
    const service = newService();
    service.activateEffect('effect.frenzy');
    service.activateEffect('effect.fortify');
    service.activateEffect('effect.stoneform');
    const beforeAttack = service.getValue('attack');
    const beforeMaxHp = service.getValue('maxHp');
    const beforeMove = service.getValue('moveSpeed');
    const tickReport = service.advanceTick(2);
    const lines: string[] = [];
    lines.push(`tick 2 前：attack=${formatNumber(beforeAttack)} maxHp=${formatNumber(beforeMaxHp)} moveSpeed=${formatNumber(beforeMove)}`);
    lines.push(`到期来源 ${tickReport.removedSourceIds.join(', ') || '（无）'}；revision=${tickReport.revision}`);
    lines.push(`到期后：attack=${formatNumber(service.getValue('attack'))} maxHp=${formatNumber(service.getValue('maxHp'))} moveSpeed=${formatNumber(service.getValue('moveSpeed'))}`);
    lines.push(`化石形态已撤销，移动速度覆盖消失：${service.explainSource('effect.stoneform#3')?.active ?? false}`);
    reports.push(block('4. 同刻多来源退出（frenzy + stoneform 恰在 tick 2 到期）', lines));
  }

  // 5. 相同数值、不同来源：卸下装备不能误删增益
  {
    const service = newService();
    service.activateEffect('effect.fortify');
    const lines: string[] = [];
    lines.push(`fortify 提供 maxHp +140，攻坚载荷也提供百分比，但数值不同；先看拆装顺序：`);
    const attach = service.getValues(['maxHp', 'attack', 'defense']);
    lines.push(`装前：${JSON.stringify(attach)}`);
    const second = service.switchLoadout('siege');
    lines.push(`切到攻坚载荷 accepted=${second.accepted}：${JSON.stringify(service.getValues(['maxHp', 'attack', 'defense']))}`);
    const detached = service.detachSource('loadout.siege.armor');
    lines.push(`卸下攻城重甲 detached=${detached}：${JSON.stringify(service.getValues(['maxHp', 'attack', 'defense']))}`);
    lines.push(`fortify 仍然生效：${service.explainSource('effect.fortify#1')?.active ?? false}；防御贡献 ${JSON.stringify(service.explainSource('effect.fortify#1')?.modifiers)}`);
    reports.push(block('5. 卸下装备只撤销对应来源，战意/壁垒不受影响', lines));
  }

  // 6. 同数值修正的身份测试（构造两条 +37 attack 的不同来源）
  {
    const catalogForDupe: AttributeCatalog = {
      ...catalog,
      loadouts: [
        {
          id: 'duel',
          label: '同值对照',
          description: '两条来源数值完全相同的加值，验证按身份撤销。',
          sources: [
            { id: 'duel.bladeAlpha', kind: 'equipment', label: '同值短刃 α' },
            { id: 'duel.bladeBeta', kind: 'equipment', label: '同值短刃 β' },
          ],
          modifiers: [
            { id: 'duel.alpha.attack', sourceId: 'duel.bladeAlpha', attribute: 'attack', op: 'flat', value: 37 },
            { id: 'duel.beta.attack', sourceId: 'duel.bladeBeta', attribute: 'attack', op: 'flat', value: 37 },
          ],
        },
      ],
      initialLoadoutId: 'duel',
    };
    const service = new AttributeService(catalogForDupe);
    const lines: string[] = [];
    lines.push(`初始 attack=${formatNumber(service.getValue('attack'))}（两条 +37）`);
    service.detachSource('duel.bladeAlpha');
    lines.push(`卸下 α 后 attack=${formatNumber(service.getValue('attack'))}，β 的贡献=${JSON.stringify(service.explain('attack').contributions.map((c) => ({ id: c.modifierId, applied: c.appliedValue })))}`);
    lines.push(`β 仍然存在：${service.listActiveSources().some((source) => source.id === 'duel.bladeBeta')}`);
    reports.push(block('6. 数值相同但来源不同：只撤销指定身份', lines));
  }

  // 7. 缺失依赖与循环定义：整图检查拒绝并指出参与者
  {
    const service = newService();
    const tweaks = candidateTweaks();
    const lines: string[] = [];
    for (const [name, candidate] of Object.entries(tweaks)) {
      const report = service.validateConfiguration(candidate);
      lines.push(`${name}: ok=${report.ok}`);
      for (const issue of report.issues) {
        const parts = [
          issue.code,
          issue.attributes?.length ? `属性=${issue.attributes.join(',')}` : '',
          issue.modifiers?.length ? `修正=${issue.modifiers.join(',')}` : '',
        ].filter(Boolean);
        lines.push(`  ${parts.join(' ')} :: ${issue.message}`);
      }
    }
    lines.push(`规则步骤映射示例：${STEP_TO_OPERATOR.addFlat} → ${STEP_TO_OPERATOR.addFlat}`);
    reports.push(block('7. 缺失依赖 / 子图存在循环 / 规则漏步骤', lines));
  }

  // 7b. 两条覆盖修正互相竞争：临时增益 vs 场景压制
  {
    const service = newService();
    service.switchLoadout('siege');
    service.activateEffect('effect.mark');
    const lines: string[] = [];
    lines.push(...stepSummary(service, 'precision'));
    lines.push(`猎手印记来源解释：${JSON.stringify(service.explainSource('effect.mark#1')?.modifiers ?? [])}`);
    reports.push(block('7b. 互相覆盖的修正（猎手印记 88 @4 vs 沙暴 30 @10）', lines));
  }

  // 8. 批量替换事务：失败后旧状态仍可算
  {
    const service = newService();
    const tweaks = candidateTweaks();
    const beforeRevision = service.getState().revision;
    const beforeValues = JSON.stringify(service.getValues(['maxHp', 'attack', 'shieldCapacity', 'shieldRegen']));
    const rejected = service.applyConfiguration(tweaks.cyclic);
    const lines: string[] = [];
    lines.push(`尝试应用循环定义：accepted=${rejected.accepted}，revision 是否变化=${service.getState().revision !== beforeRevision}`);
    lines.push(`旧状态仍可算：${beforeValues} → ${JSON.stringify(service.getValues(['maxHp', 'attack', 'shieldCapacity', 'shieldRegen']))}`);
    lines.push(`旧状态解释仍带 revision=${service.explain('maxHp').revision}`);
    reports.push(block('8. 事务式配置替换：失败不改变旧状态', lines));
  }

  return reports;
}

export function runTimeline(): readonly string[] {
  const service = newService();
  const lines: string[] = [];
  lines.push('时间线：');
  lines.push(`t0 attack=${service.getValue('attack')} maxHp=${service.getValue('maxHp')} moveSpeed=${service.getValue('moveSpeed')}`);
  service.activateEffect('effect.frenzy');
  service.activateEffect('effect.stoneform');
  lines.push(`t0+激活 attack=${service.getValue('attack')} moveSpeed=${service.getValue('moveSpeed')}（stoneform 覆盖）`);
  const tick1 = service.advanceTick(1);
  lines.push(`t${tick1.tick} 到期=[${tick1.removedSourceIds.join(',')}] attack=${service.getValue('attack')} moveSpeed=${service.getValue('moveSpeed')}`);
  return lines;
}

export const __demo = { newService };
