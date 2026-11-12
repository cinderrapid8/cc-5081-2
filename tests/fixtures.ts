import type {
  AttributeCatalog,
  AttributeRule,
  EffectTemplate,
  LoadoutDefinition,
  Modifier,
  PipelineStep,
  SourceDefinition,
  SourceKind,
} from '../src/core/types.js';
import { AttributeService } from '../src/core/service.js';

export const ALL_STEPS: readonly PipelineStep[] = [
  'addBase',
  'addFlat',
  'multiplyPercent',
  'addDerived',
  'applyOverride',
  'clamp',
];

export function rule(
  id: string,
  overrides: Partial<AttributeRule> = {},
): AttributeRule {
  return {
    id,
    label: id,
    description: id,
    pipeline: ALL_STEPS,
    clamp: { min: -1_000_000, max: 1_000_000 },
    precision: 6,
    ...overrides,
  };
}

export function source(id: string, kind: SourceKind, label = id): SourceDefinition {
  return { id, kind, label };
}

export function baseMod(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'base', value };
}

export function flatMod(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'flat', value };
}

export function percentMod(id: string, sourceId: string, attribute: string, value: number): Modifier {
  return { id, sourceId, attribute, op: 'percent', value };
}

export function overrideMod(
  id: string,
  sourceId: string,
  attribute: string,
  value: number,
  priority: number,
): Modifier {
  return { id, sourceId, attribute, op: 'override', value, priority };
}

export function deriveMod(
  id: string,
  sourceId: string,
  attribute: string,
  value: number,
  offset: number,
  dependsOn: string,
): Modifier {
  return { id, sourceId, attribute, op: 'derive', value, offset, dependsOn: [dependsOn] };
}

export interface CatalogSpec {
  rules: AttributeRule[];
  base: { source: SourceDefinition; modifiers: Modifier[] };
  system?: { sources: SourceDefinition[]; modifiers: Modifier[] };
  loadouts?: LoadoutDefinition[];
  effects?: EffectTemplate[];
  initialLoadoutId?: string;
}

export function catalog(spec: CatalogSpec): AttributeCatalog {
  const loadouts = spec.loadouts ?? [
    {
      id: 'empty',
      label: '空负载',
      description: '无装备',
      sources: [],
      modifiers: [],
    },
  ];
  return {
    rules: spec.rules,
    character: {
      id: 'character',
      name: '测试角色',
      baseSource: spec.base.source,
      baseModifiers: spec.base.modifiers,
    },
    system: spec.system ?? { sources: [], modifiers: [] },
    loadouts,
    effects: spec.effects ?? [],
    initialLoadoutId: spec.initialLoadoutId ?? loadouts[0]!.id,
  };
}

export function service(spec: CatalogSpec): AttributeService {
  return new AttributeService(catalog(spec));
}
