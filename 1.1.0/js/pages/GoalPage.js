// Sprint 24 P5: GoalPage — goal progress dashboard.
// Lists goals with status badges, task progress bars, expandable detail
// showing tasks, milestones, and acceptance criteria.
// Draft goals can be activated via POST /api/goals/:id/activate.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { goals } from '../state.js';
import { fetchGoals, getGoalDetail, activateGoal } from '../api.js';
import { setToast } from '../toast.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { Card } from '../components/Card.js';
import { T } from '../i18n.js';

// ── status badge color mapping ──────────────────────────────────
const STATUS_COLORS = {
  draft:     { cls: 'task-status-pending', label: T.goalsPage.draft },
  active:    { cls: 'task-status-active',  label: T.goalsPage.active },
  completed: { cls: 'task-status-done',    label: T.goalsPage.completed },
};

function statusBadge(s) {
  const c = STATUS_COLORS[s] || STATUS_COLORS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

// ── progress bar helper ─────────────────────────────────────────
function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`
    <div class="progress-bar">
      <div class="fill" style=${{ width: `${pct}%` }} />
    </div>
    <span class="muted-text" style="font-size:11px;">${done}/${total} 完成 · ${pct}%</span>
  `;
}

// ── GoalCard: expandable card per goal ───────────────────────────
function GoalCard({ goal }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);

  const onToggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (detail !== null) return;
    setLoading(true);
    try {
      const r = await getGoalDetail(goal.goal_id || goal.id);
      setDetail(r);
    } catch (e) {
      setToast(T.goalsPage.loadGoalsFailed + e.message, 'error');
      setExpanded(false);
    } finally { setLoading(false); }
  };

  const onActivate = async (ev) => {
    ev.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await activateGoal(goal.goal_id || goal.id);
      setToast(T.goalsPage.activated(goal.title));
    } catch (e) {
      setToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const tasks      = (detail && detail.tasks) || goal.tasks || [];
  const milestones = (detail && detail.milestones) || goal.milestones || [];
  const criteria   = (detail && detail.criteria) || goal.criteria || [];
  const taskDone   = tasks.filter((t) => t.status === 'completed' || t.status === 'done').length;
  const milestoneDone = milestones.filter((m) => m.done).length;

  return html`
    <div class="decision-card${expanded ? ' is-expanded' : ''}">
      <div class="decision-card-head" onClick=${onToggle} style="flex-wrap:wrap;">
        <div class="decision-card-info" style="flex:1;min-width:0;">
          <div class="decision-card-title-row">
            <span class="decision-card-title">${goal.title || '未命名目标'}</span>
            ${statusBadge(goal.status)}
          </div>
          <div class="decision-card-meta" style="margin-top:4px;">
            ${progressBar(taskDone, tasks.length)}
          </div>
        </div>
        <div class="decision-card-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               style=${{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>
      ${expanded ? html`
        <div class="decision-card-body">
          ${loading ? html`<p class="decision-loading">${T.decisionsPage.loadingContent}</p>` : null}
          ${!loading && detail === null && !tasks.length ? html`
            <p class="decision-loading">${T.decisionsPage.loadingContent}</p>
          ` : null}
          ${tasks.length > 0 ? html`
            <h4 style="margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink-mid);">${T.goalsPage.tasks}</h4>
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
              ${tasks.map((t) => {
                const done = t.status === 'completed' || t.status === 'done';
                const active = t.status === 'in_progress' || t.status === 'active';
                const dotCls = done ? 'task-status-done' : active ? 'task-status-active' : 'task-status-pending';
                return html`
                  <div key=${t.id || t.title} class="row" style="gap:6px;font-size:12.5px;">
                    <span class="task-status-chip ${dotCls}" style="font-size:10px;padding:1px 6px;">
                      ${done ? '✓' : active ? '●' : '○'}
                    </span>
                    <span>${t.title || t.name || '?'}</span>
                  </div>`;
              })}
            </div>
          ` : null}
          ${milestones.length > 0 ? html`
            <h4 style="margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink-mid);">${T.goalsPage.milestones}</h4>
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
              ${milestones.map((m) => html`
                <div key=${m.title} class="row" style="gap:6px;font-size:12.5px;color:${m.done ? 'var(--green)' : 'var(--ink-muted)'};">
                  <span>${m.done ? '✓' : '○'}</span>
                  <span>${m.title}</span>
                </div>`)}
            </div>
          ` : null}
          ${criteria.length > 0 ? html`
            <h4 style="margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink-mid);">${T.goalsPage.criteria}</h4>
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
              ${criteria.map((c) => html`
                <div key=${c} class="row" style="gap:6px;font-size:12.5px;color:var(--ink-muted);">
                  <span>☐</span>
                  <span>${c}</span>
                </div>`)}
            </div>
          ` : null}
          ${goal.status === 'draft' ? html`
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-soft);">
              <button class="action primary small"
                      onClick=${onActivate}
                      disabled=${busy}>
                ${busy ? T.goalsPage.activating : T.goalsPage.activate}
              </button>
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

// ── Page ─────────────────────────────────────────────────────────
export function GoalPage() {
  const list = goals.value;

  useEffect(() => {
    fetchGoals().catch(() => {});
  }, []);

  // 10s auto-refresh
  useEffect(() => {
    const timer = setInterval(() => { fetchGoals().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const counts = { draft: 0, active: 0, completed: 0 };
  for (const g of list) {
    const s = g.status || 'draft';
    if (counts[s] !== undefined) counts[s]++;
  }

  return html`
    <${PageTitleBar} title=${T.goals.title} />
    <div class="decisions-page">
      <div class="row" style="gap:var(--s-4);margin-bottom:var(--s-2);">
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark busy" /> 草稿 <strong>${counts.draft}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark idle" /> 进行中 <strong>${counts.active}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;opacity:0.7;">
          <span class="status-mark idle" style="background:var(--green);box-shadow:none;" /> 已完成 <strong>${counts.completed}</strong>
        </div>
      </div>
      <${Card} title="目标列表" flush=${true}>
        <div class="decisions-list" style="padding:0 var(--s-5) var(--s-5);">
          ${list.length === 0 ? html`
            <div class="decisions-empty">
              <p class="decisions-empty-title">${T.goalsPage.noGoals}</p>
              <p class="decisions-empty-hint">${T.goalsPage.noGoalsHint}</p>
            </div>
          ` : list.map((g) => html`
            <${GoalCard} key=${g.goal_id || g.id} goal=${g} />
          `)}
        </div>
      </${Card}>
    </div>`;
}
