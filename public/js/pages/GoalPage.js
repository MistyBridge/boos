// Sprint 24 P5: GoalPage — goal progress dashboard.
// Reuses .decision-card expand/collapse pattern (from DecisionsPage),
// .task-status-chip badges, .progress-bar, and Card component.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { goals } from '../state.js';
import { fetchGoals, getGoalDetail, activateGoal } from '../api.js';
import { setToast } from '../toast.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { Card } from '../components/Card.js';
import { T } from '../i18n.js';

const STATUS = {
  draft:     { cls: 'task-status-pending', label: T.goalsPage.draft },
  active:    { cls: 'task-status-active',  label: T.goalsPage.active },
  completed: { cls: 'task-status-done',    label: T.goalsPage.completed },
};

function statusBadge(s) {
  const c = STATUS[s] || STATUS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`
    <div class="progress-bar">
      <div class="fill" style=${{ width: `${pct}%` }} />
    </div>
    <span style="font-size:11px;color:var(--ink-muted);">${done}/${total} · ${pct}%</span>`;
}

// ── Checks / indicators for milestones and criteria ──────────────
function CheckDot({ done }) {
  return html`<span style="color:${done ? 'var(--green)' : 'var(--ink-muted)'};font-size:12px;">
    ${done ? '✓' : '○'}</span>`;
}

// ── GoalCard: expandable item using .decision-card + .decision-card-head ──
function GoalCard({ goal }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [busy, setBusy]         = useState(false);

  const tasks      = (detail && detail.tasks) || goal.tasks || [];
  const milestones = (detail && detail.milestones) || goal.milestones || [];
  const criteria   = (detail && detail.criteria) || goal.criteria || [];
  const taskDone   = tasks.filter((t) => t.status === 'completed' || t.status === 'done').length;

  async function onToggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (detail !== null) return;
    setLoading(true);
    try { setDetail(await getGoalDetail(goal.goal_id || goal.id)); }
    catch (e) { setToast(T.goalsPage.loadGoalsFailed + e.message, 'error'); setExpanded(false); }
    finally { setLoading(false); }
  }

  async function onActivate(ev) {
    ev.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await activateGoal(goal.goal_id || goal.id);
      setToast(T.goalsPage.activated(goal.title));
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

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
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>
      ${expanded ? html`
        <div class="decision-card-body">
          ${loading ? html`<p class="decision-loading">${T.decisionsPage.loadingContent}</p>` : null}
          ${!loading ? html`
            <div style="display:flex;flex-direction:column;gap:var(--s-4);">
              ${tasks.length > 0 ? html`
                <div>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.04em;">${T.goalsPage.tasks}</p>
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    ${tasks.map((t) => {
                      const done = t.status === 'completed' || t.status === 'done';
                      const active = t.status === 'in_progress' || t.status === 'active';
                      return html`
                        <div key=${t.id || t.title} class="row" style="gap:6px;font-size:12.5px;">
                          <span class=${`task-status-chip ${done ? 'task-status-done' : active ? 'task-status-active' : 'task-status-pending'}`}
                                style="font-size:10px;padding:1px 6px;">${done ? '✓' : active ? '●' : '○'}</span>
                          <span style="color:${done ? 'var(--ink-muted)' : 'var(--ink)'};">${t.title || t.name || '?'}</span>
                        </div>`;
                    })}
                  </div>
                </div>
              ` : null}
              ${milestones.length > 0 ? html`
                <div>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.04em;">${T.goalsPage.milestones}</p>
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    ${milestones.map((m) => html`
                      <div key=${m.title} class="row" style="gap:6px;font-size:12.5px;">
                        <${CheckDot} done=${m.done} /><span>${m.title}</span>
                      </div>`)}
                  </div>
                </div>
              ` : null}
              ${criteria.length > 0 ? html`
                <div>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.04em;">${T.goalsPage.criteria}</p>
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    ${criteria.map((c) => html`
                      <div key=${c} class="row" style="gap:6px;font-size:12.5px;color:var(--ink-muted);">
                        <span>☐</span><span>${c}</span>
                      </div>`)}
                  </div>
                </div>
              ` : null}
              ${goal.status === 'draft' ? html`
                <div class="form-actions" style="padding-top:var(--s-3);border-top:1px solid var(--border-soft);justify-content:flex-start;">
                  <button class="action small primary" onClick=${onActivate} disabled=${busy}>
                    ${busy ? T.goalsPage.activating : T.goalsPage.activate}
                  </button>
                </div>
              ` : null}
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

// ── Page ─────────────────────────────────────────────────────────
export function GoalPage() {
  const list = Array.isArray(goals.value) ? goals.value : [];

  useEffect(() => {
    fetchGoals().catch(() => {});
    const t = setInterval(() => fetchGoals().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, []);

  const counts = { draft: 0, active: 0, completed: 0 };
  for (const g of list) { const s = g.status || 'draft'; if (counts[s] !== undefined) counts[s]++; }

  return html`<${ErrorBoundary} name="GoalPage">
    <${PageTitleBar} title=${T.goals.title} />
    <div class="decisions-page">
      <div class="row" style="gap:var(--s-4);margin-bottom:var(--s-3);">
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark" style=${{ background: 'var(--ink-faint)', boxShadow: 'none' }} />
          草稿 <strong>${counts.draft}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark busy" />
          进行中 <strong>${counts.active}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;opacity:0.6;">
          <span class="status-mark" style=${{ background: 'var(--green)', boxShadow: 'none' }} />
          已完成 <strong>${counts.completed}</strong>
        </div>
      </div>
      ${list.length === 0 ? html`
        <div class="decisions-empty">
          <p class="decisions-empty-title">${T.goalsPage.noGoals}</p>
          <p class="decisions-empty-hint">${T.goalsPage.noGoalsHint}</p>
        </div>
      ` : list.map((g) => html`<${GoalCard} key=${g.goal_id || g.id} goal=${g} />`)}
    </div>
  </${ErrorBoundary}>`;
}
