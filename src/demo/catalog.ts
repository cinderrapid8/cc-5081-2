import type {
  AttributeCatalog,
  AttributeRule,
  EffectTemplate,
  LoadoutDefinition,
  Modifier,
  SourceDefinition,
} from '../core/types.js';

/**
 * 演示数据。属性规则决定顺序；来源与修正全部以身份命名，
 * 便于在测试和面板里精确追踪「哪一件装备/哪一个增益」贡献了什么。
 */

const rules: AttributeRule[] = [
  {
    id: 'maxHp',
    label: '生命上限',
    description: '装备与场景先修正，最终钳位到 1..99999。护盾容量依赖它。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 1, max: 99999 },
    precision: 3,
  },
  {
    id: 'attack',
    label: '攻击力',
    description: '基础 120，装备与增益按固定值/百分比修正，无派生依赖。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 0, max: 5000 },
    precision: 3,
  },
  {
    id: 'defense',
    label: '防御',
    description: '受场景压制影响，钳位到 0..2000。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 0, max: 2000 },
    precision: 3,
  },
  {
    id: 'shieldCapacity',
    label: '护盾容量',
    description: '由生命上限派生：上限 × 0.35 + 40。显式依赖 maxHp。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 0, max: 40000 },
    precision: 3,
  },
  {
    id: 'shieldRegen',
    label: '护盾再生',
    description: '由护盾容量派生，形成 maxHp → shieldCapacity → shieldRegen 的链。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 0, max: 5000 },
    precision: 3,
  },
  {
    id: 'moveSpeed',
    label: '移动速度',
    description: '负倍率与覆盖修正的演示属性。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 10, max: 400 },
    precision: 3,
  },
  {
    id: 'precision',
    label: '命中精度',
    description: '展示同类覆盖修正的优先级竞争。',
    pipeline: ['addBase', 'addFlat', 'multiplyPercent', 'addDerived', 'applyOverride', 'clamp'],
    clamp: { min: 0, max: 200 },
    precision: 3,
  },
];

function flat(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'flat', value };
}

function percent(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'percent', value };
}

function base(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'base', value };
}

const character = {
  id: 'character',
  name: '巡林客',
  baseSource: {
    id: 'character.base',
    kind: 'base' as const,
    label: '角色基础面板',
  },
  baseModifiers: [
    base('base.maxHp', 'character.base', 'maxHp', 820),
    base('base.attack', 'character.base', 'attack', 120),
    base('base.defense', 'character.base', 'defense', 240),
    base('base.moveSpeed', 'character.base', 'moveSpeed', 180),
    base('base.precision', 'character.base', 'precision', 72),
    base('base.shieldCapacity', 'character.base', 'shieldCapacity', 0),
    base('base.shieldRegen', 'character.base', 'shieldRegen', 0),
  ],
};

const systemSources: SourceDefinition[] = [
  {
    id: 'system.hpToShield',
    kind: 'derived',
    label: '生命上限→护盾换算',
  },
  {
    id: 'system.shieldToRegen',
    kind: 'derived',
    label: '护盾容量→再生换算',
  },
];

const systemModifiers: Modifier[] = [
  {
    id: 'derive.shieldCapacity.maxHp',
    sourceId: 'system.hpToShield',
    attribute: 'shieldCapacity',
    op: 'derive',
    value: 0.35,
    offset: 40,
    dependsOn: ['maxHp'],
  },
  {
    id: 'derive.shieldRegen.shieldCapacity',
    sourceId: 'system.shieldToRegen',
    attribute: 'shieldRegen',
    op: 'derive',
    value: 0.12,
    offset: 6,
    dependsOn: ['shieldCapacity'],
  },
];

const fieldKit: LoadoutDefinition = {
  id: 'field',
  label: '野外载荷',
  description: '轻甲 + 短刃，适合长线探索。',
  sources: [
    { id: 'loadout.field.armor', kind: 'equipment', label: '游侠轻甲' },
    { id: 'loadout.field.blade', kind: 'equipment', label: '林间短刃' },
    { id: 'loadout.field.weather', kind: 'pressure', label: '雨季湿地（压制）' },
  ],
  modifiers: [
    flat('field.armor.defense', 'loadout.field.armor', 'defense', 85),
    percent('field.armor.maxHp', 'loadout.field.armor', 'maxHp', 0.08),
    flat('field.blade.attack.flat', 'loadout.field.blade', 'attack', 46),
    percent('field.blade.attack.percent', 'loadout.field.blade', 'attack', 0.12),
    percent('field.weather.moveSpeed', 'loadout.field.weather', 'moveSpeed', -0.25),
    percent('field.weather.attack', 'loadout.field.weather', 'attack', -0.1),
  ],
};

const siegeKit: LoadoutDefinition = {
  id: 'siege',
  label: '攻坚载荷',
  description: '重甲与攻城锤，同时被沙暴场景压制。',
  sources: [
    { id: 'loadout.siege.armor', kind: 'equipment', label: '攻城重甲' },
    { id: 'loadout.siege.hammer', kind: 'equipment', label: '攻城锤' },
    { id: 'loadout.siege.weather', kind: 'pressure', label: '沙暴场景（压制）' },
  ],
  modifiers: [
    flat('siege.armor.defense', 'loadout.siege.armor', 'defense', 220),
    percent('siege.armor.maxHp', 'loadout.siege.armor', 'maxHp', 0.22),
    flat('siege.hammer.attack.flat', 'loadout.siege.hammer', 'attack', 130),
    percent('siege.hammer.attack.percent', 'loadout.siege.hammer', 'attack', -0.18),
    percent('siege.weather.moveSpeed', 'loadout.siege.weather', 'moveSpeed', -0.45),
    percent('siege.weather.precision', 'loadout.siege.weather', 'precision', -0.3),
    {
      id: 'siege.weather.override.precision',
      sourceId: 'loadout.siege.weather',
      attribute: 'precision',
      op: 'override',
      value: 30,
      priority: 10,
    },
  ],
};

const loadouts: LoadoutDefinition[] = [fieldKit, siegeKit];

const effects: EffectTemplate[] = [
  {
    id: 'effect.frenzy',
    label: '战意激涌',
    description: '攻击 +18%，持续 2 回合。与装备百分比叠加，与化石形态同刻到期。',
    kind: 'buff',
    durationTicks: 2,
    modifiers: [
      percent('frenzy.attack', 'effect.frenzy', 'attack', 0.18),
    ],
  },
  {
    id: 'effect.fortify',
    label: '壁垒强化',
    description: '生命上限固定 +140，防御 +60，持续 4 回合。',
    kind: 'buff',
    durationTicks: 4,
    modifiers: [
      flat('fortify.maxHp', 'effect.fortify', 'maxHp', 140),
      flat('fortify.defense', 'effect.fortify', 'defense', 60),
    ],
  },
  {
    id: 'effect.stoneform',
    label: '化石形态',
    description: '移动速度覆盖为 40，优先级 20，持续 2 回合。',
    kind: 'buff',
    durationTicks: 2,
    modifiers: [
      {
        id: 'stoneform.override.moveSpeed',
        sourceId: 'effect.stoneform',
        attribute: 'moveSpeed',
        op: 'override',
        value: 40,
        priority: 20,
      },
    ],
  },
  {
    id: 'effect.mark',
    label: '猎手印记',
    description: '命中精度覆盖为 88，优先级 4；在攻坚载荷下会被沙暴覆盖（优先级 10）压掉。',
    kind: 'buff',
    durationTicks: 3,
    modifiers: [
      {
        id: 'mark.override.precision',
        sourceId: 'effect.mark',
        attribute: 'precision',
        op: 'override',
        value: 88,
        priority: 4,
      },
    ],
  },
];

export const DEMO_CATALOG: AttributeCatalog = {
  rules,
  character,
  system: {
    sources: systemSources,
    modifiers: systemModifiers,
  },
  loadouts,
  effects,
  initialLoadoutId: 'field',
};
