import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const dist = resolve(import.meta.dirname, '../dist');

async function loadPanel(): Promise<JSDOM> {
  const [html, script] = await Promise.all([
    readFile(resolve(dist, 'index.html'), 'utf8'),
    readFile(resolve(dist, 'app.js'), 'utf8'),
  ]);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

function text(dom: JSDOM, selector: string): string {
  return dom.window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function click(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  assert.ok(element, `missing element ${selector}`);
  element.click();
}

function attributeValue(dom: JSDOM, attribute: string): string {
  const cards = [...dom.window.document.querySelectorAll<HTMLElement>('.attribute-card')];
  const card = cards.find((entry) => entry.dataset.attribute === attribute);
  assert.ok(card, `missing attribute card ${attribute}`);
  return card.querySelector('.attribute-value')?.textContent?.trim() ?? '';
}

describe('面板读取真实求值结果', () => {
  let dom: JSDOM | null = null;

  before(() => {});
  after(() => {
    dom?.window.close();
    dom = null;
  });

  it('初始渲染包含所有属性与负载', async () => {
    dom = await loadPanel();
    const cards = dom.window.document.querySelectorAll('.attribute-card');
    assert.equal(cards.length, 7);
    assert.equal(attributeValue(dom, 'maxHp'), '885.6');
    assert.equal(attributeValue(dom, 'shieldCapacity'), '349.96');
    assert.match(text(dom, '.badge.accent'), /野外载荷/);
    assert.match(text(dom, '.badge'), /revision 1/);
  });

  it('切换负载后面板值与服务求值一致', async () => {
    dom = await loadPanel();
    assert.equal(attributeValue(dom, 'attack'), '169.32');
    click(dom, '[data-action="loadout"][data-loadout="siege"]');
    assert.equal(attributeValue(dom, 'attack'), '205');
    assert.equal(attributeValue(dom, 'precision'), '30');
    assert.match(text(dom, '.badge.accent'), /攻坚载荷/);

    click(dom, '[data-action="select"][data-attribute="precision"]');
    const rows = [...dom.window.document.querySelectorAll<HTMLElement>('.contributions tbody tr')];
    const overrideRow = rows.find((row) => row.dataset.modifierId === 'siege.weather.override.precision');
    assert.ok(overrideRow, '未展示覆盖修正行');
    assert.match(overrideRow.textContent ?? '', /-20\.4/);
  });

  it('激活效果后属性变化，到期后回退', async () => {
    dom = await loadPanel();
    const beforeAttack = attributeValue(dom, 'attack');
    click(dom, '[data-action="effect"][data-effect="effect.frenzy"]');
    assert.equal(attributeValue(dom, 'attack'), '199.2');
    assert.notEqual(attributeValue(dom, 'attack'), beforeAttack);
    assert.match(text(dom, '.notice'), /effect\.frenzy#1/);

    click(dom, '[data-action="advance"]');
    click(dom, '[data-action="advance"]');
    assert.equal(attributeValue(dom, 'attack'), '169.32');
    assert.match(text(dom, '.notice'), /到期/);
  });

  it('同刻到期多个来源时面板一次性更新', async () => {
    dom = await loadPanel();
    click(dom, '[data-action="effect"][data-effect="effect.frenzy"]');
    click(dom, '[data-action="effect"][data-effect="effect.stoneform"]');
    assert.equal(attributeValue(dom, 'moveSpeed'), '40');
    click(dom, '[data-action="advance"]');
    click(dom, '[data-action="advance"]');
    assert.equal(attributeValue(dom, 'moveSpeed'), '135');
    assert.ok((text(dom, '.notice')).includes('effect.frenzy#1'));
    assert.ok((text(dom, '.notice')).includes('effect.stoneform#2'));
  });

  it('选择属性展示步骤与来源解释', async () => {
    dom = await loadPanel();
    click(dom, '[data-action="select"][data-attribute="shieldCapacity"]');
    assert.match(text(dom, '.detail h2'), /护盾容量/);
    const steps = [...dom.window.document.querySelectorAll<HTMLElement>('.steps tbody tr')];
    assert.equal(steps.length, 6);
    assert.equal(steps.at(-1)?.querySelector('td')?.textContent?.trim(), '最终钳位');
    assert.match(text(dom, '.detail-value'), /maxHp = 885\.6/);
  });

  it('候选配置整图检查失败时不改变面板值', async () => {
    dom = await loadPanel();
    assert.equal(attributeValue(dom, 'shieldCapacity'), '349.96');
    click(dom, '[data-action="load-config"]');
    assert.match(text(dom, '.notice'), /未通过检查/);
    assert.equal(attributeValue(dom, 'shieldCapacity'), '349.96');
    const issues = dom.window.document.querySelectorAll('.issue');
    assert.ok(issues.length > 0);
    assert.match(issues[0]?.textContent ?? '', /dependency-cycle/);
    const applyButton = dom.window.document.querySelector<HTMLButtonElement>('[data-action="apply-config"]');
    assert.equal(applyButton?.disabled, true);
  });
});
