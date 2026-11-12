import type {
  AttributeRule,
  ConfigurationCandidate,
  EffectTemplate,
  LoadoutDefinition,
  Modifier,
  PipelineStep,
  SourceDefinition,
  SourceKind,
  ValidationIssue,
} from '../core/types.js';
import { isFiniteNumber } from '../core/numeric.js';
import { REQUIRED_STEPS } from '../core/validate.js';

/**
 * 规则服务加载的完整规则包。它比核心的 AttributeCatalog 多了版本元数据，
 * 但字段形状保持一致，因此可以直接构造 AttributeService。
 */
export interface RuleBundle {
  readonly version: string;
  readonly label: string;
  readonly createdAt: string;
  readonly rules: readonly AttributeRule[];
  readonly character: {
    readonly id: string;
    readonly name: string;
    readonly baseSource: SourceDefinition;
    readonly baseModifiers: readonly Modifier[];
  };
  readonly system: {
    readonly sources: readonly SourceDefinition[];
    readonly modifiers: readonly Modifier[];
  };
  readonly loadouts: readonly LoadoutDefinition[];
  readonly effects: readonly EffectTemplate[];
  readonly initialLoadoutId: string;
}

export interface ParseResult {
  readonly ok: boolean;
  readonly bundle: RuleBundle | null;
  readonly issues: readonly ValidationIssue[];
}

const MODIFIER_OPS = ['base', 'flat', 'percent', 'override', 'derive'] as const;
const SOURCE_KINDS: readonly SourceKind[] = ['base', 'equipment', 'buff', 'pressure', 'derived'];
const STEP_SET = new Set<PipelineStep>(REQUIRED_STEPS);

function issue(code: ValidationIssue['code'], message: string, extra?: Partial<ValidationIssue>): ValidationIssue {
  return { code, message, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value);
}

function asString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseSource(value: unknown, path: string, issues: ValidationIssue[]): SourceDefinition | null {
  if (!isRecord(value)) {
    issues.push(issue('malformed-document', `${path} 必须是对象`));
    return null;
  }
  const kind = value.kind;
  if (!asString(value.id)) {
    issues.push(issue('malformed-document', `${path}.id 必须是非空字符串`));
    return null;
  }
  if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as SourceKind)) {
    issues.push(
      issue('invalid-source-kind', `${path}（${value.id as string}）的来源类型 ${String(kind)} 未知，允许：${SOURCE_KINDS.join(' / ')}`, {
        sources: asString(value.id) ? [value.id] : [],
      }),
    );
    return null;
  }
  const source: SourceDefinition = {
    id: value.id,
    kind: kind as SourceKind,
    label: asString(value.label) ? value.label : value.id,
  };
  if (Number.isInteger(value.expiresAtTick)) {
    return { ...source, expiresAtTick: value.expiresAtTick as number };
  }
  return source;
}

function parseModifier(value: unknown, path: string, issues: ValidationIssue[]): Modifier | null {
  if (!isRecord(value)) {
    issues.push(issue('malformed-document', `${path} 必须是对象`));
    return null;
  }
  const id = asString(value.id) ? value.id : null;
  const sourceId = asString(value.sourceId) ? value.sourceId : null;
  const attribute = asString(value.attribute) ? value.attribute : null;
  if (!id || !sourceId || !attribute) {
    issues.push(issue('malformed-document', `${path} 缺少必填的 id / sourceId / attribute 字符串字段`));
    return null;
  }
  const op = value.op;
  if (typeof op !== 'string' || !MODIFIER_OPS.includes(op as (typeof MODIFIER_OPS)[number])) {
    issues.push(
      issue('unknown-operator', `修正 ${id} 的运算符 ${String(op)} 未知，允许：${MODIFIER_OPS.join(' / ')}`, {
        modifiers: [id],
        sources: [sourceId],
      }),
    );
    return null;
  }
  const ref = { modifiers: [id], sources: [sourceId], attributes: [attribute] };

  if (op === 'derive') {
    const dependsOn = Array.isArray(value.dependsOn) ? value.dependsOn : null;
    const dep = dependsOn && dependsOn.length === 1 && asString(dependsOn[0]) ? dependsOn[0] : null;
    if (!dep) {
      issues.push(issue('malformed-document', `派生修正 ${id} 的 dependsOn 必须是恰好一个属性 id`, ref));
      return null;
    }
    if (!asFiniteNumber(value.value) || !asFiniteNumber(value.offset)) {
      issues.push(issue('invalid-number', `派生修正 ${id} 的 value / offset 必须是有限数值`, ref));
      return null;
    }
    return { id, sourceId, attribute, op: 'derive', value: value.value, offset: value.offset, dependsOn: [dep] };
  }
  if (!asFiniteNumber(value.value)) {
    issues.push(issue('invalid-number', `修正 ${id} 的 value 必须是有限数值`, ref));
    return null;
  }
  if (op === 'override') {
    if (!asFiniteNumber(value.priority)) {
      issues.push(issue('invalid-number', `覆盖修正 ${id} 的 priority 必须是有限数值`, ref));
      return null;
    }
    return { id, sourceId, attribute, op: 'override', value: value.value, priority: value.priority };
  }
  const simpleOp = op as 'base' | 'flat' | 'percent';
  return { id, sourceId, attribute, op: simpleOp, value: value.value };
}

function parseRule(value: unknown, path: string, issues: ValidationIssue[]): AttributeRule | null {
  if (!isRecord(value)) {
    issues.push(issue('malformed-document', `${path} 必须是对象`));
    return null;
  }
  if (!asString(value.id)) {
    issues.push(issue('malformed-document', `${path}.id 必须是非空字符串`));
    return null;
  }
  const id = value.id;
  if (!Array.isArray(value.pipeline) || value.pipeline.length === 0) {
    issues.push(issue('invalid-pipeline', `属性 ${id} 的 pipeline 必须是非空数组`, { attributes: [id] }));
    return null;
  }
  const pipeline: PipelineStep[] = [];
  for (const step of value.pipeline) {
    if (typeof step !== 'string' || !STEP_SET.has(step as PipelineStep)) {
      issues.push(
        issue('unknown-operator', `属性 ${id} 的规则含未知求值步骤 ${String(step)}，允许：${REQUIRED_STEPS.join(' / ')}`, {
          attributes: [id],
        }),
      );
      return null;
    }
    pipeline.push(step as PipelineStep);
  }
  const clamp = isRecord(value.clamp) ? value.clamp : null;
  if (
    !clamp ||
    !asFiniteNumber(clamp.min) ||
    !asFiniteNumber(clamp.max) ||
    (clamp.min as number) > (clamp.max as number)
  ) {
    issues.push(issue('invalid-number', `属性 ${id} 的 clamp 必须是 min <= max 的有限数值`, { attributes: [id] }));
    return null;
  }
  if (!Number.isInteger(value.precision) || (value.precision as number) < 0 || (value.precision as number) > 8) {
    issues.push(issue('invalid-number', `属性 ${id} 的 precision 必须是 0..8 的整数`, { attributes: [id] }));
    return null;
  }
  return {
    id,
    label: asString(value.label) ? value.label : id,
    description: asString(value.description) ? value.description : '',
    pipeline,
    clamp: { min: clamp.min as number, max: clamp.max as number },
    precision: value.precision as number,
  };
}

function parseLoadout(value: unknown, index: number, issues: ValidationIssue[]): LoadoutDefinition | null {
  const path = `loadouts[${index}]`;
  if (!isRecord(value) || !asString(value.id)) {
    issues.push(issue('malformed-document', `${path} 必须是带 id 的对象`));
    return null;
  }
  const sources = Array.isArray(value.sources)
    ? value.sources.map((entry, i) => parseSource(entry, `${path}.sources[${i}]`, issues)).filter((s): s is SourceDefinition => s !== null)
    : [];
  const modifiers = Array.isArray(value.modifiers)
    ? value.modifiers.map((entry, i) => parseModifier(entry, `${path}.modifiers[${i}]`, issues)).filter((m): m is Modifier => m !== null)
    : [];
  return {
    id: value.id,
    label: asString(value.label) ? value.label : value.id,
    description: asString(value.description) ? value.description : '',
    sources,
    modifiers,
  };
}

function parseEffect(value: unknown, index: number, issues: ValidationIssue[]): EffectTemplate | null {
  const path = `effects[${index}]`;
  if (!isRecord(value) || !asString(value.id)) {
    issues.push(issue('malformed-document', `${path} 必须是带 id 的对象`));
    return null;
  }
  if (!Number.isInteger(value.durationTicks) || (value.durationTicks as number) <= 0) {
    issues.push(issue('invalid-number', `效果 ${value.id as string} 的 durationTicks 必须是正整数`));
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as SourceKind)) {
    issues.push(issue('invalid-source-kind', `效果 ${value.id as string} 的来源类型 ${String(kind)} 未知`));
    return null;
  }
  const modifiers = Array.isArray(value.modifiers)
    ? value.modifiers.map((entry, i) => parseModifier(entry, `${path}.modifiers[${i}]`, issues)).filter((m): m is Modifier => m !== null)
    : [];
  return {
    id: value.id,
    kind: kind as SourceKind,
    label: asString(value.label) ? value.label : value.id,
    description: asString(value.description) ? value.description : '',
    durationTicks: value.durationTicks as number,
    modifiers,
  };
}

/**
 * 把不受信 JSON 文档解析成强类型 RuleBundle。
 * 结构问题以 malformed-document 报告，语义未知项（运算符/步骤/来源类型）
 * 以 unknown-operator / invalid-source-kind 报告，绝不抛异常。
 */
export function parseRuleBundle(document: unknown): ParseResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(document)) {
    return { ok: false, bundle: null, issues: [issue('malformed-document', '规则文档必须是 JSON 对象')] };
  }
  if (!asString(document.version)) {
    issues.push(issue('malformed-document', '规则文档缺少 version 字符串'));
  }
  const rules = Array.isArray(document.rules)
    ? document.rules.map((entry, i) => parseRule(entry, `rules[${i}]`, issues)).filter((r): r is AttributeRule => r !== null)
    : [];
  if (!Array.isArray(document.rules)) {
    issues.push(issue('malformed-document', 'rules 必须是数组'));
  }

  const character = isRecord(document.character) ? document.character : null;
  let baseSource: SourceDefinition | null = null;
  let baseModifiers: Modifier[] = [];
  if (character) {
    baseSource = parseSource(character.baseSource, 'character.baseSource', issues);
    baseModifiers = Array.isArray(character.baseModifiers)
      ? character.baseModifiers.map((entry, i) => parseModifier(entry, `character.baseModifiers[${i}]`, issues)).filter((m): m is Modifier => m !== null)
      : [];
  } else {
    issues.push(issue('malformed-document', '缺少 character 对象'));
  }

  const system = isRecord(document.system) ? document.system : {};
  const systemSources = Array.isArray(system.sources)
    ? system.sources.map((entry, i) => parseSource(entry, `system.sources[${i}]`, issues)).filter((s): s is SourceDefinition => s !== null)
    : [];
  const systemModifiers = Array.isArray(system.modifiers)
    ? system.modifiers.map((entry, i) => parseModifier(entry, `system.modifiers[${i}]`, issues)).filter((m): m is Modifier => m !== null)
    : [];

  const loadouts = Array.isArray(document.loadouts)
    ? document.loadouts.map((entry, i) => parseLoadout(entry, i, issues)).filter((l): l is LoadoutDefinition => l !== null)
    : [];
  const effects = Array.isArray(document.effects)
    ? document.effects.map((entry, i) => parseEffect(entry, i, issues)).filter((e): e is EffectTemplate => e !== null)
    : [];

  const initialLoadoutId = asString(document.initialLoadoutId) ? document.initialLoadoutId : '';
  if (!asString(document.initialLoadoutId)) {
    issues.push(issue('malformed-document', '缺少 initialLoadoutId 字符串'));
  }

  if (issues.length > 0 || !baseSource || !asString(document.version)) {
    return { ok: false, bundle: null, issues };
  }

  const bundle: RuleBundle = {
    version: document.version,
    label: asString(document.label) ? document.label : document.version,
    createdAt: asString(document.createdAt) ? document.createdAt : '',
    rules,
    character: {
      id: asString(character!.id) ? character!.id : 'character',
      name: asString(character!.name) ? character!.name : '测试角色',
      baseSource,
      baseModifiers,
    },
    system: { sources: systemSources, modifiers: systemModifiers },
    loadouts,
    effects,
    initialLoadoutId,
  };
  return { ok: true, bundle, issues: [] };
}

/** 规则包中可热替换的系统部分，对应核心的 ConfigurationCandidate。 */
export function toConfigurationCandidate(bundle: RuleBundle): ConfigurationCandidate {
  return {
    rules: bundle.rules,
    sources: bundle.system.sources,
    modifiers: bundle.system.modifiers,
  };
}
