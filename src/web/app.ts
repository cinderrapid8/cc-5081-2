import { DEMO_CATALOG } from '../demo/catalog.js';
import { AttributeService } from '../core/service.js';
import { buildPanelModel, type PanelModel } from './viewmodel.js';
import type { ConfigurationCandidate, ValidationReport } from '../core/types.js';
import { escapeHtml } from './escape.js';

/**
 * 浏览器侧控制器：事件只做命令转发，所有展示数据都由 viewmodel
 * 从 AttributeService 当前求值快照重新构建。
 */

let service = new AttributeService(DEMO_CATALOG);
let selectedAttributeId: string | null = DEMO_CATALOG.rules[0]?.id ?? null;
let notice: string | null = null;
let lastCandidate: ConfigurationCandidate | null = null;
let lastReport: ValidationReport | null = null;

function model(): PanelModel {
  return buildPanelModel(service, { selectedAttributeId, notice });
}

export function renderPanel(root: HTMLElement): void {
  const data = model();
  root.innerHTML = `
    <header class="topbar">
      <div>
        <h1>角色属性求值服务</h1>
        <p class="subtitle">展示内容全部读取自服务当前快照，不在面板里重算公式。</p>
      </div>
      <div class="state">
        <span class="badge">${escapeHtml(data.revisionText)}</span>
        <span class="badge">${escapeHtml(data.tickText)}</span>
        <span class="badge accent">负载：${escapeHtml(data.loadoutText)}</span>
      </div>
    </header>
    ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''}
    <section class="loadout-bar">
      <span class="section-label">负载配置</span>
      ${data.loadouts
        .map(
          (loadout) => `
        <button class="loadout ${loadout.active ? 'active' : ''}" data-action="loadout" data-loadout="${escapeHtml(loadout.id)}" title="${escapeHtml(loadout.description)}">
          ${escapeHtml(loadout.label)}
        </button>`,
        )
        .join('')}
      <span class="spacer"></span>
      <button class="ghost" data-action="advance">推进 1 tick</button>
    </section>
    <main class="layout">
      <section class="attributes">
        <h2>属性面板</h2>
        <div class="attribute-grid">
          ${data.cards
            .map(
              (card) => `
            <button class="attribute-card ${card.id === data.selectedAttributeId ? 'selected' : ''}" data-action="select" data-attribute="${escapeHtml(card.id)}">
              <span class="attribute-name">${escapeHtml(card.label)}</span>
              <span class="attribute-value">${escapeHtml(card.valueText)}</span>
              <span class="attribute-meta">${card.clamped ? `钳位前 ${escapeHtml(card.preClampText)}` : '未触发钳位'}</span>
            </button>`,
            )
            .join('')}
        </div>
      </section>
      <section class="detail">
        ${renderDetail(data)}
      </section>
      <aside class="sidebar">
        <h2>活动来源</h2>
        <ul class="source-list">
          ${data.sources
            .map(
              (source) => `
            <li class="source ${escapeHtml(source.kind)}">
              <div class="source-head">
                <span class="source-label">${escapeHtml(source.label)}</span>
                <span class="tag">${escapeHtml(source.kindLabel)}</span>
                <span class="tag muted">${escapeHtml(source.originLabel)}</span>
              </div>
              <div class="source-meta">${escapeHtml(source.id)} · ${source.modifierCount} 条修正 · ${escapeHtml(source.expiresText)}</div>
            </li>`,
            )
            .join('')}
        </ul>
        <h2>临时效果</h2>
        <ul class="effect-list">
          ${data.effects
            .map(
              (effect) => `
            <li class="effect">
              <div class="source-head">
                <span class="source-label">${escapeHtml(effect.label)}</span>
                ${effect.activeInstance ? `<span class="tag">生效 ${escapeHtml(effect.activeInstance)}</span>` : ''}
              </div>
              <div class="source-meta">${escapeHtml(effect.description)}</div>
              <button class="ghost" data-action="effect" data-effect="${escapeHtml(effect.id)}">
                ${effect.activeInstance ? '结束效果' : '激活效果'}
              </button>
            </li>`,
            )
            .join('')}
        </ul>
        <h2>依赖图</h2>
        <ul class="edge-list">
          ${
            data.edges.length === 0
              ? '<li class="source-meta">当前没有派生依赖</li>'
              : data.edges
                  .map(
                    (edge) => `
            <li class="edge">
              <span class="edge-arrow">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>
              <span class="source-meta">${escapeHtml(edge.sourceLabel)} · ${escapeHtml(edge.sourceKind)}</span>
            </li>`,
                  )
                  .join('')
          }
        </ul>
        <h2>批量配置</h2>
        ${renderConfigurationPanel()}
      </aside>
    </main>
  `;
}

function renderDetail(data: PanelModel): string {
  const card = data.cards.find((entry) => entry.id === data.selectedAttributeId) ?? data.cards[0];
  if (!card) return '<p class="source-meta">没有可展示的属性。</p>';
  return `
    <h2>${escapeHtml(card.label)} <span class="mono">${escapeHtml(card.id)}</span></h2>
    <p class="description">${escapeHtml(card.description)}</p>
    <div class="detail-value">
      <strong>${escapeHtml(card.valueText)}</strong>
      <span class="source-meta">钳位前 ${escapeHtml(card.preClampText)}${card.clamped ? '（已钳位）' : ''}</span>
      <span class="source-meta">${escapeHtml(card.dependencyText)}</span>
    </div>
    <h3>求值步骤</h3>
    <table class="steps">
      <thead><tr><th>步骤</th><th>输入</th><th>输出</th><th>增量</th><th>桶汇总</th></tr></thead>
      <tbody>
        ${card.steps
          .map(
            (step) => `
          <tr class="${step.applied ? '' : 'inactive'}">
            <td>${escapeHtml(step.label)}</td>
            <td class="mono">${escapeHtml(step.input)}</td>
            <td class="mono">${escapeHtml(step.output)}</td>
            <td class="mono">${escapeHtml(step.delta)}</td>
            <td class="mono">${escapeHtml(step.aggregate ?? '—')}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <h3>贡献来源（read from evaluation）</h3>
    <table class="contributions">
      <thead><tr><th>来源</th><th>类型</th><th>修正</th><th>录入</th><th>实际贡献</th><th>说明</th></tr></thead>
      <tbody>
        ${card.contributions
          .map(
            (contribution) => `
          <tr class="${contribution.shadowed ? 'shadowed' : ''}" data-source-id="${escapeHtml(contribution.sourceId)}" data-modifier-id="${escapeHtml(contribution.modifierId)}">
            <td>${escapeHtml(contribution.sourceLabel)}<div class="source-meta mono">${escapeHtml(contribution.sourceId)}</div></td>
            <td>${escapeHtml(contribution.sourceKindLabel)}</td>
            <td>${escapeHtml(contribution.op)}<div class="source-meta mono">${escapeHtml(contribution.modifierId)}</div></td>
            <td class="mono">${escapeHtml(contribution.input)}</td>
            <td class="mono">${escapeHtml(contribution.applied)}</td>
            <td>${escapeHtml(contribution.note)}${contribution.shadowed ? ' <span class="tag muted">被覆盖</span>' : ''}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderConfigurationPanel(): string {
  if (!lastReport) {
    return `
      <p class="source-meta">载入一组故意有循环定义的候选配置，先整图检查再决定是否应用。</p>
      <button class="ghost" data-action="load-config">载入候选配置</button>
    `;
  }
  return `
    <p class="source-meta">候选配置整图检查：${lastReport.ok ? '通过' : '拒绝'}</p>
    <ul class="issues">
      ${lastReport.issues
        .map(
          (issue) => `<li class="issue"><span class="tag">${escapeHtml(issue.code)}</span>${escapeHtml(issue.message)}</li>`,
        )
        .join('')}
    </ul>
    <button class="ghost" data-action="apply-config" ${lastReport.ok ? '' : 'disabled'}>
      应用候选配置
    </button>
    <button class="ghost" data-action="clear-config">清除候选</button>
  `;
}

function buildCyclicCandidate(): ConfigurationCandidate {
  const modifiers = DEMO_CATALOG.system.modifiers.map((modifier) =>
    modifier.op === 'derive' && modifier.id === 'derive.shieldCapacity.maxHp'
      ? { ...modifier, dependsOn: ['shieldRegen'] as const }
      : modifier,
  );
  return { rules: DEMO_CATALOG.rules, sources: DEMO_CATALOG.system.sources, modifiers };
}

function handleClick(event: Event): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  // 切换负载时默认选中攻击力，便于直接核对覆盖修正的竞争结果。
  if (action === 'loadout') selectedAttributeId = 'attack';
  notice = null;
  switch (action) {
    case 'select': {
      selectedAttributeId = target.dataset.attribute ?? selectedAttributeId;
      break;
    }
    case 'loadout': {
      const loadoutId = target.dataset.loadout;
      if (!loadoutId) break;
      const result = service.switchLoadout(loadoutId);
      notice = result.accepted
        ? `已切换到 ${loadoutId}`
        : `切换被拒绝：${result.report.issues.map((issue) => issue.message).join('；')}`;
      break;
    }
    case 'effect': {
      const effectId = target.dataset.effect;
      if (!effectId) break;
      const active = service.listActiveEffects().find((effect) => effect.id.startsWith(`${effectId}#`));
      if (active) {
        service.deactivateEffect(active.id);
        notice = `已结束效果 ${active.id}`;
      } else {
        const instance = service.activateEffect(effectId);
        notice = `已激活效果 ${instance.instanceId}`;
      }
      break;
    }
    case 'advance': {
      const report = service.advanceTick(1);
      notice = report.removedSourceIds.length > 0
        ? `tick ${report.tick}：到期 ${report.removedSourceIds.join(', ')}`
        : `tick ${report.tick}：无来源到期`;
      break;
    }
    case 'load-config': {
      lastCandidate = buildCyclicCandidate();
      lastReport = service.validateConfiguration(lastCandidate);
      notice = lastReport.ok ? '候选配置通过检查' : '候选配置未通过检查，角色状态未变化';
      break;
    }
    case 'apply-config': {
      if (!lastCandidate) break;
      const result = service.applyConfiguration(lastCandidate);
      notice = result.accepted ? '候选配置已应用' : '应用被拒绝，旧状态保持可算';
      lastReport = result.report;
      break;
    }
    case 'clear-config': {
      lastCandidate = null;
      lastReport = null;
      break;
    }
    default:
      break;
  }
  const root = document.querySelector<HTMLElement>('#app');
  if (root) renderPanel(root);
}

export function mount(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('missing #app');
  document.addEventListener('click', handleClick);
  renderPanel(root);
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', mount);
}
