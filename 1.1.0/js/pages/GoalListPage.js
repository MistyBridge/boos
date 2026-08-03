// Sprint 37: GoalListPage — goal list with filter tabs, sort, progress bars,
// and quick actions (activate / start / pause / archive / create).
// Reuses goals signal + API. Complements GoalPage's expandable detail view.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { goals } from '../state.js';
import { fetchGoals, activateGoal, startGoal, pauseGoal, archiveGoal } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { GoalCreateModal } from '../components/GoalCreateModal.js';

// ── Constants ──────────────────────────────────────────────────────

const STATUS = {
  draft:     { cls: 'task-status-pending', label: '草稿' },
  active:    { cls: 'task-status-active',  label: '进行中' },
  paused:    { cls: 'task-status-pending', label: '已暂停' },
  completed: { cls: 'task-status-done',    label: '已完成' },
  archived:  { cls: 'task-status-cancel',  label: '已归档' },
};

const FILTER_TABS = [
  { key: 'all',       label: '全部' },
  { key: 'active',    label: '进行中' },
  { key: 'draft',     label: '草稿' },
  { key: 'completed', label: '已完成' },
];

const SORT_OPTIONS = [
  { key: 'title',    label: '名称' },
  { key: 'progress', label: '进度' },
  { key: 'status',   label: '状态' },
  { key: 'updated',  label: '更新时间' },
];

const STATUS_ORDER = { active: 0, paused: 1, draft: 2, completed: 3, archived: 4 };

// ── Helpers ────────────────────────────────────────────────────────

function statusBadge(s) {
  const c = STATUS[s] || STATUS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

function taskProgress(goal) {
  const tasks = goal.tasks || [];
  const done = tasks.filter((t) => t.status === 'completed' || t.status === 'done').length;
  return { done, total: tasks.length };
}

function ProgressBar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`
    <div style="display:flex;align-items:center;gap:6px;min-width:90px;">
      <div style="flex:1;height:4px;background:var(--border);border-radius:999px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${pct >= 100 ? 'var(--green)' : 'var(--ink-mid)'};border-radius:999px;transition:width .3s ease;" />
      </div>
      <span style="font-size:11px;color:var(--ink-muted);font-variant-numeric:tabular-nums;white-space:nowrap;">${done}/${total}</span>
    </div>`;
}

function sortGoals(list, key) {
  const arr = [...list];
  switch (key) {
    case 'progress':
      arr.sort((a, b) => {
        const pa = taskProgress(a), pb = taskProgress(b);
        return (pb.total ? pb.done / pb.total : 0) - (pa.total ? pa.done / pa.total : 0);
      });
      break;
    case 'status':
      arr.sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
      break;
    case 'updated':
      arr.sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime());
      break;
    default: // title
      arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  return arr;
}

// ── GoalRow ────────────────────────────────────────────────────────

function GoalRow({ goal, onRefresh, onSelect }) {
  const [busy, setBusy] = useState(false);
  const { done, total } = taskProgress(goal);
  const dags = goal.dags || [];
  const s = goal.status;

  const canActivate = s === 'draft';
  const canStart    = s === 'draft' || s === 'paused';
  const canPause    = s === 'active';
  const canArchive  = s === 'completed' || s === 'paused';

  async function doAction(fn, label, needConfirm) {
    if (busy) return;
    if (needConfirm) {
      const ok = await boosConfirm(needConfirm);
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fn(goal.goal_id || goal.id);
      if (r && r.ok) { setToast(label); onRefresh(); }
      else if (r && r.error) { setToast(r.error, 'error'); }
    } catch (e) { setToast(e.message || '操作失败', 'error'); }
    setBusy(false);
  }

  return html`
    <div class="decision-card" style="cursor:pointer;padding:var(--s-2) var(--s-3);">
      <div onClick=${() => onSelect && onSelect(goal)}>
        <div style="display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap;">
          <!-- title + status -->
          <div style="flex:1;min-width:120px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:13px;font-weight:500;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${goal.title || '未命名目标'}
            </span>
            ${statusBadge(s)}
          </div>

          <!-- progress -->
          <${ProgressBar} done=${done} total=${total} />

          <!-- meta -->
          <span style="font-size:11px;color:var(--ink-muted);white-space:nowrap;">
            DAG ${dags.length}
          </span>
          <span style="font-size:11px;color:var(--ink-muted);white-space:nowrap;">
            ${goal.updated_at ? new Date(goal.updated_at).toLocaleDateString() : '-'}
          </span>
        </div>

        ${goal.description ? html`
          <p style="font-size:12px;color:var(--ink-muted);margin:4px 0 0;line-height:1.4;
                    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
            ${goal.description.slice(0, 200)}
          </p>
        ` : null}
      </div>

      <!-- actions -->
      <div style="display:flex;gap:6px;margin-top:var(--s-2);" onClick=${(e) => e.stopPropagation()}>
        ${canActivate ? html`
          <button class="action subtle small" style="font-size:11px;padding:2px 10px;"
                  onClick=${() => doAction(activateGoal, '已激活', null)} disabled=${busy}>
            激活
          </button>
        ` : null}
        ${canStart ? html`
          <button class="action subtle small" style="font-size:11px;padding:2px 10px;"
                  onClick=${() => doAction(startGoal, '已启动', `启动目标「${goal.title}」？PM 将开始执行关联的 DAG 任务。`)} disabled=${busy}>
            启动
          </button>
        ` : null}
        ${canPause ? html`
          <button class="action subtle small" style="font-size:11px;padding:2px 10px;"
                  onClick=${() => doAction(pauseGoal, '已暂停', `暂停目标「${goal.title}」？`)} disabled=${busy}>
            暂停
          </button>
        ` : null}
        ${canArchive ? html`
          <button class="action subtle small" style="font-size:11px;padding:2px 10px;"
                  onClick=${() => doAction(archiveGoal, '已归档', `归档目标「${goal.title}」？`)} disabled=${busy}>
            归档
          </button>
        ` : null}
      </div>
    </div>`;
}

// ── Page ───────────────────────────────────────────────────────────

export function GoalListPage({ onNavigate }) {
  const [tab, setTab] = useState('active');
  const [sort, setSort] = useState('status');
  const [showCreate, setShowCreate] = useState(false);

  const list = Array.isArray(goals.value) ? goals.value : [];

  const load = () => fetchGoals().catch(() => setToast('加载目标列表失败', 'error'));

  // initial load + 10s auto-poll
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  // filter
  const filtered = (() => {
    if (tab === 'all') return list.filter((g) => g.status !== 'archived');
    if (tab === 'active') return list.filter((g) => g.status === 'active' || g.status === 'draft' || g.status === 'paused');
    return list.filter((g) => (g.status || 'draft') === tab);
  })();

  const sorted = sortGoals(filtered, sort);

  const handleSelect = (goal) => {
    if (onNavigate) onNavigate('goal-detail', goal.goal_id || goal.id);
  };

  return html`
    <${ErrorBoundary} name="GoalListPage">
      <${PageTitleBar} title="目标列表" />

      <div class="decisions-page">
        <!-- toolbar: tabs + sort + create -->
        <div style="display:flex;align-items:center;gap:var(--s-2);margin-bottom:var(--s-3);flex-wrap:wrap;">
          <div class="decisions-filter">
            ${FILTER_TABS.map((t) => html`
              <button key=${t.key} class="decision-filter-tab ${tab === t.key ? 'is-active' : ''}"
                      onClick=${() => setTab(t.key)}>
                ${t.label}
              </button>
            `)}
          </div>

          <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--ink-muted);">排序</span>
            <select class="field" style="font-size:12px;padding:3px 6px;"
                    value=${sort} onChange=${(e) => setSort(e.target.value)}>
              ${SORT_OPTIONS.map((o) => html`
                <option key=${o.key} value=${o.key}>${o.label}</option>
              `)}
            </select>
          </div>

          <button class="action primary small" onClick=${() => setShowCreate(true)} style="font-size:12px;padding:4px 14px;">
            新建目标
          </button>
        </div>

        <!-- list -->
        ${sorted.length === 0 ? html`
          <div class="decisions-empty">
            <h3 class="decisions-empty-title">暂无目标</h3>
            <p class="decisions-empty-hint">${tab === 'all' ? '创建第一个目标来开始 DAG 任务编排。' : '此状态下没有目标。'}</p>
          </div>
        ` : html`
          <div class="decisions-list">
            ${sorted.map((g) => html`
              <${GoalRow} key=${g.goal_id || g.id} goal=${g} onRefresh=${load} onSelect=${handleSelect} />
            `)}
          </div>
        `}
      </div>

      ${showCreate ? html`
        <${GoalCreateModal}
          onClose=${() => setShowCreate(false)}
          onCreated=${() => { setShowCreate(false); load(); }} />
      ` : null}
    </${ErrorBoundary}>`;
}
