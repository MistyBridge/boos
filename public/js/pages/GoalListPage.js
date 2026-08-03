// Sprint 37 Phase 4: GoalListPage — card-based goal list with inline actions.
// Calls goal_list + goal_status. Supports create/archive/pause/start.
// Route: /goals (sidebar "目标" tab)

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { goals } from '../state.js';
import { fetchGoals, startGoal, pauseGoal, archiveGoal, getGoalDetail } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { GoalCreateModal } from '../components/GoalCreateModal.js';
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

function GoalCard({ goal, onSelect, onAction }) {
  const [busy, setBusy] = useState(false);
  const dags = goal.dags || [];
  const dagCount = dags.length;
  const updated = goal.updated_at || goal.created_at || '';
  const s = goal.status;

  const canStart = s === 'draft' || s === 'paused';
  const canPause = s === 'active';
  const canArchive = s === 'completed' || s === 'paused';

  const doAction = async (action, e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      let r;
      if (action === 'start') {
        if (!await boosConfirm(`启动目标「${goal.title}」？PM 将开始执行关联的 DAG 任务。`)) { setBusy(false); return; }
        r = await startGoal(goal.goal_id || goal.id);
      } else if (action === 'pause') {
        if (!await boosConfirm(`暂停目标「${goal.title}」？`)) { setBusy(false); return; }
        r = await pauseGoal(goal.goal_id || goal.id);
      } else if (action === 'archive') {
        if (!await boosConfirm(`归档目标「${goal.title}」？`)) { setBusy(false); return; }
        r = await archiveGoal(goal.goal_id || goal.id);
      }
      if (r && r.ok) {
        setToast(action === 'start' ? '已启动' : action === 'pause' ? '已暂停' : '已归档');
        if (onAction) onAction();
      } else if (r && r.error) {
        setToast(r.error);
      }
    } catch (err) { setToast(err.message || '操作失败'); }
    setBusy(false);
  };

  return html`
    <div class="decision-card" style="cursor:pointer;">
      <div class="decision-card-head" onClick=${() => onSelect && onSelect(goal)}>
        <span class="decision-card-title" style="font-weight:600;font-size:15px;">${goal.title || '未命名目标'}</span>
        <span style="display:flex;gap:6px;align-items:center;">
          ${statusBadge(s)}
        </span>
      </div>
      <div class="decision-card-meta" style="display:flex;gap:var(--s-3);font-size:12px;color:var(--ink-mid);margin-top:4px;" onClick=${() => onSelect && onSelect(goal)}>
        <span>DAG: ${dagCount}</span>
        <span>更新: ${updated ? new Date(updated).toLocaleDateString() : '-'}</span>
      </div>
      ${goal.description ? html`
        <p style="font-size:13px;color:var(--ink-muted);margin:var(--s-1) 0 0;line-height:1.4;
                  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;"
           onClick=${() => onSelect && onSelect(goal)}>
          ${goal.description.slice(0, 200)}
        </p>
      ` : null}
      <div style="display:flex;gap:var(--s-1);margin-top:var(--s-2);" onClick=${(e) => e.stopPropagation()}>
        ${canStart ? html`<button class="action subtle" style="font-size:11px;padding:2px 10px;" onClick=${(e) => doAction('start', e)} disabled=${busy}>▶ 启动</button>` : null}
        ${canPause ? html`<button class="action subtle" style="font-size:11px;padding:2px 10px;" onClick=${(e) => doAction('pause', e)} disabled=${busy}>⏸ 暂停</button>` : null}
        ${canArchive ? html`<button class="action subtle" style="font-size:11px;padding:2px 10px;" onClick=${(e) => doAction('archive', e)} disabled=${busy}>📦 归档</button>` : null}
      </div>
    </div>`;
}

export function GoalListPage({ onNavigate }) {
  const [tab, setTab] = useState('active');
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const list = Array.isArray(goals.value) ? goals.value : [];
  const filtered = list.filter((g) => {
    if (tab === 'active') return g.status !== 'archived';
    return g.status === 'archived';
  });

  const load = async () => {
    setLoading(true);
    await fetchGoals().catch(() => setToast('加载目标列表失败'));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSelect = (goal) => {
    if (onNavigate) onNavigate('goal-detail', goal.goal_id || goal.id);
  };

  const handleNew = () => setShowCreate(true);

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
            ${filtered.map((g) => html`<${GoalCard} key=${g.goal_id || g.id} goal=${g} onSelect=${handleSelect} onAction=${load} />`)}
          </div>
        ` : null}
      </div>

      ${showCreate ? html`<${GoalCreateModal}
        onClose=${() => setShowCreate(false)}
        onCreated=${() => { setShowCreate(false); load(); }} />` : null}
    </${ErrorBoundary}>`;
}
