import type { AttributeService } from '../core/service.js';
import type { Modifier } from '../core/types.js';
import type { RuleBundle } from './rule-bundle.js';

export interface ProbeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly detail: string;
}

export interface ProbeReport {
  readonly passed: boolean;
  readonly version: string;
  readonly checks: readonly ProbeCheck[];
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function check(name: string, expected: unknown, actual: unknown, detail: string): ProbeCheck {
  return { name, passed: JSON.stringify(expected) === JSON.stringify(actual), expected, actual, detail };
}

/** 从规则包读出某属性当前的派生修正（换算公式），数据驱动而非硬编码。 */
function deriveFormula(bundle: RuleBundle, attribute: string): Modifier | null {
  const all = [...bundle.system.modifiers, ...bundle.character.baseModifiers];
  for (const loadout of bundle.loadouts) all.push(...loadout.modifiers);
  const derive = all.find((modifier) => modifier.attribute === attribute && modifier.op === 'derive');
  return derive ?? null;
}

/**
 * 启动探针。它不检查端口是否监听，而是：
 * 1. 用已确认规则集创建一个测试角色；
 * 2. 实际在两组负载配置之间装卸；
 * 3. 按规则包里声明的派生换算公式，独立复算派生链数值并与服务结果核对；
 * 4. 再卸回初始负载，确认可逆、状态一致。
 *
 * 任一数值不符即整体失败，入口据此以探针退出码终止，绝不带故障上线。
 */
export function runStartupProbe(service: AttributeService, bundle: RuleBundle): ProbeReport {
  const checks: ProbeCheck[] = [];
  const loadoutIds = bundle.loadouts.map((loadout) => loadout.id);
  if (loadoutIds.length < 2) {
    return {
      passed: false,
      version: bundle.version,
      checks: [
        {
          name: 'probe-requires-two-loadouts',
          passed: false,
          detail: `探针需要至少两组负载配置，当前只有 ${loadoutIds.length} 组`,
        },
      ],
    };
  }

  const precisionOf = (attribute: string): number =>
    bundle.rules.find((rule) => rule.id === attribute)?.precision ?? 3;

  const verifyDerivedChain = (phase: string): void => {
    const values = service.getValues(bundle.rules.map((rule) => rule.id));
    for (const rule of bundle.rules) {
      const formula = deriveFormula(bundle, rule.id);
      if (!formula || formula.op !== 'derive') continue;
      const dependency = formula.dependsOn[0]!;
      const dependencyValue = (values as Record<string, number>)[dependency]!;
      const expected = round(dependencyValue * formula.value + formula.offset, precisionOf(rule.id));
      const actual = round((values as Record<string, number>)[rule.id]!, precisionOf(rule.id));
      checks.push(
        check(
          `${phase}-derived-${rule.id}`,
          expected,
          actual,
          `${rule.id} = ${dependency}(${round(dependencyValue, 6)}) × ${formula.value} + ${formula.offset}`,
        ),
      );
    }
  };

  const initialId = bundle.initialLoadoutId;
  const otherId = loadoutIds.find((id) => id !== initialId)!;

  // 1. 创建测试角色并装载初始负载，核对派生链。
  const baseline = service.getValues(bundle.rules.map((rule) => rule.id));
  checks.push(check('initial-loadout-mounted', initialId, service.getActiveLoadoutId(), '测试角色已创建并装载初始负载'));
  verifyDerivedChain('initial');

  // 2. 实际装载第二组配置，派生数值必须重算且与公式一致。
  const switchOut = service.switchLoadout(otherId);
  checks.push(check('switch-to-second-loadout', true, switchOut.accepted, `实际装载第二组配置 ${otherId}`));
  checks.push(check('second-loadout-active', otherId, service.getActiveLoadoutId(), '第二组配置处于活动状态'));
  verifyDerivedChain('second');
  const afterSwitch = service.getValues(bundle.rules.map((rule) => rule.id));
  checks.push(
    check('two-configs-differ', true, JSON.stringify(afterSwitch) !== JSON.stringify(baseline), '两组配置产生不同派生数值'),
  );

  // 3. 卸回初始负载，数值必须精确回到基线，证明装卸可逆、来源按身份撤销。
  const switchBack = service.switchLoadout(initialId);
  checks.push(check('switch-back-accepted', true, switchBack.accepted, `卸回初始负载 ${initialId}`));
  const restored = service.getValues(bundle.rules.map((rule) => rule.id));
  checks.push(
    check('restore-baseline-values', baseline, restored, '卸回后派生数值与基线完全一致'),
    check('restore-active-loadout', initialId, service.getActiveLoadoutId(), '活动负载恢复为初始配置'),
  );

  return { passed: checks.every((entry) => entry.passed), version: bundle.version, checks };
}
