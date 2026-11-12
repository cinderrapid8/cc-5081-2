import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuleBundle, toConfigurationCandidate } from '../../src/rule-service/rule-bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

async function loadJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(repoRoot, relative), 'utf8'));
}

describe('规则包运行时解析（不受信 JSON 边界）', () => {
  it('解析合法 v1 规则包并保留全部字段', async () => {
    const doc = await loadJson('rules/v1/rules.json');
    const result = parseRuleBundle(doc);
    assert.equal(result.ok, true);
    assert.ok(result.bundle);
    assert.equal(result.bundle.version, 'v1');
    assert.equal(result.bundle.rules.length, 7);
    assert.equal(result.bundle.loadouts.length, 2);
    assert.ok(result.issues.length === 0);
  });

  it('可转换为核心 ConfigurationCandidate', async () => {
    const doc = await loadJson('rules/v2/rules.json');
    const result = parseRuleBundle(doc);
    const candidate = toConfigurationCandidate(result.bundle!);
    assert.equal(candidate.rules.length, 7);
    assert.ok(candidate.sources.length >= 2);
  });

  it('未知运算符报 unknown-operator 而非抛异常', async () => {
    const doc = await loadJson('deploy/candidates/unknown-operator.json');
    const result = parseRuleBundle(doc);
    assert.equal(result.ok, false);
    assert.equal(result.bundle, null);
    assert.ok(result.issues.some((i) => i.code === 'unknown-operator' && /double-dip/.test(i.message)));
  });

  it('未知求值步骤同样报 unknown-operator', async () => {
    const doc = await loadJson('deploy/candidates/unknown-step.json');
    const result = parseRuleBundle(doc);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'unknown-operator' && /warpReality/.test(i.message)));
  });

  it('未知来源类型报 invalid-source-kind', () => {
    const doc = {
      version: 'x',
      initialLoadoutId: 'L',
      rules: [],
      character: {
        id: 'c',
        name: 'c',
        baseSource: { id: 'b', kind: 'ghost', label: 'b' },
        baseModifiers: [],
      },
      system: { sources: [], modifiers: [] },
      loadouts: [],
      effects: [],
    };
    const result = parseRuleBundle(doc);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'invalid-source-kind'));
  });

  it('畸形文档报 malformed-document', () => {
    assert.equal(parseRuleBundle(null).issues[0]!.code, 'malformed-document');
    assert.equal(parseRuleBundle('nope').issues[0]!.code, 'malformed-document');
    assert.equal(parseRuleBundle({}).issues.some((i) => i.code === 'malformed-document'), true);
  });

  it('非有限数值报 invalid-number', () => {
    const doc = {
      version: 'x',
      initialLoadoutId: 'L',
      rules: [
        { id: 'a', label: 'a', description: '', pipeline: ['addBase', 'clamp'], clamp: { min: 0, max: 1 }, precision: 2 },
      ],
      character: {
        id: 'c',
        name: 'c',
        baseSource: { id: 'b', kind: 'base', label: 'b' },
        baseModifiers: [{ id: 'm', sourceId: 'b', attribute: 'a', op: 'base', value: Number.NaN }],
      },
      system: { sources: [], modifiers: [] },
      loadouts: [],
      effects: [],
    };
    const result = parseRuleBundle(doc);
    assert.ok(result.issues.some((i) => i.code === 'invalid-number'));
  });
});
