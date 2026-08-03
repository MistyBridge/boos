// Sprint 37: GoalListPage — card-based goal list with active/archived tabs.
// Reuses .decision-card expand/collapse pattern from existing codebase.
// Route: /goals (sidebar "目标" tab)

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { goals } from '../state.js';
import { fetchGoals } from '../api.js';
import { setToast } from '../toast.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { T } from '../i18n.js';

const STATUS = {
  draft:     { cls: 'task-status-pending', label: '草稿' },
  active:    { cls: 'task-status-active',  label: '进行中' },
  paused:    { cls: 'task-status-pending', label: '已暂停' },
  completed: { cls: 'task-status-done',    label: '已完成' },
  archived:  { cls: 'task-status-cancel',  label: '已归档' },
};

const TABS = [
  { key: 'active', label: '进行中' },
  { key: 'archived', label: '已归档' },
];

function statusBadge(s) {
  const c = STATUS[s] || STATUS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

function GoalCard({ goal, onSelect }) {
  const dags = goal.dags || [];
  const dagCount = dags.length;
  const updated = goal.updated_at || goal.created_at || '';

  return html`
    <div class="decision-card" onClick=${() => onSelect && onSelect(goal)} style="cursor:pointer;">
      <div class="decision-card-head">
        <span class="decision-card-title" style="font-weight:600;font-size:15px;">${goal.title || '未命名目标'}</span>
        <span style="display:flex;gap:6px;align-items:center;">
          ${statusBadge(goal.status)}
        </span>
      </div>
      <div class="decision-card-meta" style="display:flex;gap:var(--s-3);font-size:12px;color:var(--ink-mid);margin-top:4px;">
        <span>DAG: ${dagCount}</span>
        <span>更新: ${updated ? new Date(updated).toLocaleDateString() : '-'}</span>
      </div>
      ${goal.description ? html`
        <p style="font-size:13px;color:var(--ink-muted);margin:var(--s-1) 0 0;line-height:1.4;
                  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
          ${goal.description.slice(0, 200)}
        </p>
      ` : null}
    </div>`;
}

export function GoalListPage({ onNavigate }) {
  const [tab, setTab] = useState('active');
  const [loading, setLoading] = useState(false);

  const list = Array.isArray(goals.value) ? goals.value : [];
  const filtered = list.filter((g) => {
    if (tab === 'active') return g.status !== 'archived';
    return g.status === 'archived';
  });

  useEffect(() => {
    setLoading(true);
    fetchGoals().catch(() => setToast('加载目标列表失败')).finally(() => setLoading(false));
  }, []);

  const handleSelect = (goal) => {
    if (onNavigate) onNavigate('goal-detail', goal.goal_id || goal.id);
  };

  const handleNew = () => {
    if (onNavigate) onNavigate('goal-new');
  };

  return html`
    <${ErrorBoundary} name="GoalListPage">
      <${PageTitleBar} title=${T.goalsPage?.title || '目标'} />
      <div class="settings-scroll">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-3);">
          <div class="decisions-filter">
            ${TABS.map((t) => html`
              <button class="decision-filter-tab ${tab === t.key ? 'is-active' : ''}"
                      onClick=${() => setTab(t.key)}>
                ${t.label}
              </button>
            `)}
          </div>
          <button class="action primary" onClick=${handleNew} style="font-size:13px;">+ 新建目标</button>
        </div>

        ${loading ? html`<p class="decision-loading">加载中…</p>` : null}
        ${!loading && filtered.length === 0 ? html`
          <div class="decisions-empty">
            <h3 class="decisions-empty-title">暂无目标</h3>
            <p class="decisions-empty-hint">创建第一个目标来开始 DAG 任务编排。</p>
          </div>
        ` : null}
        ${filtered.length > 0 ? html`
          <div class="decisions-list">
            ${filtered.map((g) => html`<${GoalCard} key=${g.goal_id || g.id} goal=${g} onSelect=${handleSelect} />`)}
          </div>
        ` : null}
      </div>
    </${ErrorBoundary}>`;
}
