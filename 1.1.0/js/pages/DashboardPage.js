// Sprint 32 Phase 3: DashboardPage — DAG progress visualization.
// Pattern: follows GoalPage card expand/collapse + DecisionPage approval flow.
// Backend REST proxy endpoints (/api/dags/*) bridge to agent-bus MCP dag_* tools.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { dagList } from '../state.js';
import { fetchDagList, fetchDagStatus, approveDagTask, rejectDagTask } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm, boosPrompt } from '../dialog.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { DagStatusPanel } from '../components/DagStatusPanel.js';
import { T } from '../i18n.js';

// ── Constants ────────────────────────────────────────────────────────────

const DAG_STATUS_MAP = {
  draft:     { cls: 'task-status-pending',   label: T.dashboardPage.status_draft },
  active:    { cls: 'task-status-active',    label: T.dashboardPage.status_active },
  completed: { cls: 'task-status-done',      label: T.dashboardPage.status_completed },
  cancelled: { cls: 'task-status-rejected',  label: T.dashboardPage.status_cancelled },
};

const TASK_STATUS_MAP = {
  pending:    { cls: 'task-status-pending',   label: T.dashboardPage.task_pending,    bg: 'var(--ink-faint)' },
  active:     { cls: 'task-status-active',    label: T.dashboardPage.task_active,     bg: 'var(--blue)' },
  submitted:  { cls: 'task-status-reviewing', label: T.dashboardPage.task_submitted,  bg: '#e6b422' },
  approved:   { cls: 'task-status-done',      label: T.dashboardPage.task_approved,   bg: 'var(--green)' },
  rejected:   { cls: 'task-status-rejected',  label: T.dashboardPage.task_rejected,   bg: 'var(--red)' },
  escalated:  { cls: 'task-status-escalated', label: T.dashboardPage.task_escalated,  bg: '#e67e22' },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function dagStatusBadge(status) {
  const c = DAG_STATUS_MAP[status] || DAG_STATUS_MAP.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

function taskStatusBadge(status) {
  const c = TASK_STATUS_MAP[status] || TASK_STATUS_MAP.pending;
  return html`<span class="task-status-chip ${c.cls}"
    style=${{ borderColor: c.bg, color: c.bg }}>${c.label}</span>`;
}

function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`
    <div class="progress-bar" style="margin-top:2px;">
      <div class="fill" style=${{ width: `${pct}%`, background: 'var(--ink)' }} />
    </div>
    <span style="font-size:10.5px;color:var(--ink-muted);">${done}/${total} · ${pct}%</span>`;
}

// ── DagCard: expandable DAG item ─────────────────────────────────────────
function DagCard({ dag }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [busyTask, setBusyTask] = useState(null);   // task_id being approved/rejected

  const total   = dag.total ?? dag.task_count ?? 0;
  const done    = dag.approved ?? 0;
  const dagId   = dag.dag_id || dag.id;

  async function onToggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (detail !== null) return;
    setLoading(true);
    try { setDetail(await fetchDagStatus(dagId)); }
    catch (e) { setToast(T.dashboardPage.loadDagsFailed + e.message, 'error'); setExpanded(false); }
    finally { setLoading(false); }
  }

  async function onApprove(taskId, taskTitle) {
    const ok = await boosConfirm(
      T.dashboardPage.approveTitle,
      T.dashboardPage.approveConfirm(taskTitle),
      T.dashboardPage.approve
    );
    if (!ok) return;
    setBusyTask(taskId);
    try {
      await approveDagTask(taskId);
      setToast(T.dashboardPage.approved(taskTitle), 'ok');
      // Refresh detail
      const fresh = await fetchDagStatus(dagId);
      setDetail(fresh);
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusyTask(null); }
  }

  async function onReject(taskId, taskTitle) {
    const comment = await boosPrompt(
      T.dashboardPage.rejectTitle,
      T.dashboardPage.rejectHint,
      ''
    );
    if (comment === null) return; // cancelled
    setBusyTask(taskId);
    try {
      await rejectDagTask(taskId, comment);
      setToast(T.dashboardPage.rejected(taskTitle), 'ok');
      const fresh = await fetchDagStatus(dagId);
      setDetail(fresh);
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusyTask(null); }
  }

  const tasks = (detail && detail.tasks) || [];

  // Build a lookup map for dependency names
  const taskMap = {};
  for (const t of tasks) taskMap[t.task_id || t.id] = t;

  return html`
    <div class="decision-card${expanded ? ' is-expanded' : ''}">
      <div class="decision-card-head" onClick=${onToggle}>
        <div class="decision-card-info" style="flex:1;min-width:0;">
          <div class="decision-card-title-row">
            <span class="decision-card-title">${dag.title || dagId}</span>
            ${dagStatusBadge(dag.status)}
          </div>
          <div class="decision-card-meta" style="margin-top:4px;display:flex;align-items:center;gap:8px;">
            ${progressBar(done, total)}
            <span style="font-size:10.5px;color:var(--ink-muted);">
              ${dag.active ?? 0} 活跃 · ${dag.submitted ?? 0} 待审批
            </span>
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
          ${loading ? html`<p class="decision-loading">${T.decisions ? T.decisions.loadingContent || '加载中…' : '加载中…'}</p>` : null}
          ${!loading && tasks.length === 0 ? html`
            <p style="color:var(--ink-muted);font-size:12.5px;text-align:center;padding:var(--s-3);">暂无任务</p>
          ` : null}
          ${!loading ? html`
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${tasks.map((task) => {
                const tid    = task.task_id || task.id;
                const status = task.status || 'pending';
                const isSubmitted = status === 'submitted';
                const depIds  = task.dependencies || [];
                const depNames = depIds.map((did) => {
                  const dep = taskMap[did];
                  return dep ? (dep.title || did.slice(0, 12)) : did.slice(0, 12);
                });
                return html`
                  <div key=${tid}
                    class="row"
                    style="gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;align-items:flex-start;">
                    <!-- Left: status + info -->
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">
                      <div class="row" style="gap:6px;align-items:center;">
                        ${taskStatusBadge(status)}
                        <span style="font-size:12.5px;font-weight:500;color:var(--ink);">${task.title || tid}</span>
                        ${task.retry_count > 0 ? html`
                          <span style="font-size:10px;color:var(--red);">${T.dashboardPage.task_retries(task.retry_count)}</span>
                        ` : null}
                      </div>
                      ${depNames.length > 0 ? html`
                        <div class="row" style="gap:4px;font-size:10.5px;color:var(--ink-muted);">
                          <span style="font-weight:500;">${T.dashboardPage.task_deps}:</span>
                          ${depNames.map((dn, i) => html`
                            <span key=${i}>
                              ${i > 0 ? html`<span style="margin:0 3px;">${T.dashboardPage.depArrow}</span>` : null}
                              <span class="mono-tag">${dn}</span>
                            </span>`)}
                        </div>
                      ` : null}
                    </div>
                    <!-- Right: meta + actions -->
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                      <div style="font-size:10px;color:var(--ink-muted);text-align:right;">
                        <div>${T.dashboardPage.task_executor}: <span class="mono-tag">${task.executor_name || task.executor_uid || '?'}</span></div>
                        <div>${T.dashboardPage.task_reviewer}: <span class="mono-tag">${task.reviewer_name || task.reviewer_uid || '?'}</span></div>
                      </div>
                      ${isSubmitted ? html`
                        <div class="row" style="gap:4px;">
                          <button class="action small primary" style="font-size:11px;padding:3px 8px;"
                            disabled=${busyTask === tid}
                            onClick=${(ev) => { ev.stopPropagation(); ev.preventDefault(); onApprove(tid, task.title || tid.slice(0, 16)); }}>
                            ${busyTask === tid ? '…' : T.dashboardPage.approve}
                          </button>
                          <button class="action small danger" style="font-size:11px;padding:3px 8px;"
                            disabled=${busyTask === tid}
                            onClick=${(ev) => { ev.stopPropagation(); ev.preventDefault(); onReject(tid, task.title || tid.slice(0, 16)); }}>
                            ${busyTask === tid ? '…' : T.dashboardPage.reject}
                          </button>
                        </div>
                      ` : null}
                    </div>
                  </div>`;
              })}
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

// ── Page ─────────────────────────────────────────────────────────────────
export function DashboardPage() {
  const list = Array.isArray(dagList.value) ? dagList.value : [];

  useEffect(() => {
    fetchDagList().then((r) => {
      if (r && Array.isArray(r.dags)) dagList.value = r.dags;
      else if (Array.isArray(r)) dagList.value = r;
    }).catch(() => {});
    const t = setInterval(() => {
      fetchDagList().then((r) => {
        if (r && Array.isArray(r.dags)) dagList.value = r.dags;
        else if (Array.isArray(r)) dagList.value = r;
      }).catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  // Summary counts
  let draft = 0, active = 0, completed = 0, cancelled = 0;
  for (const d of list) {
    const s = d.status || 'draft';
    if (s === 'draft') draft++;
    else if (s === 'active') active++;
    else if (s === 'completed') completed++;
    else if (s === 'cancelled') cancelled++;
  }

  return html`<${ErrorBoundary} name="DashboardPage">
    <${PageTitleBar} title=${T.dashboard.title} />
    <div class="decisions-page">
      <!-- DAG status overview (Sprint 37) -->
      <${DagStatusPanel} workspace="boos" />

      <!-- Summary bar -->
      <div class="row" style="gap:var(--s-4);margin-bottom:var(--s-3);">
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark" style=${{ background: 'var(--ink-faint)', boxShadow: 'none' }} />
          草稿 <strong>${draft}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;">
          <span class="status-mark busy" />
          活跃 <strong>${active}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;opacity:0.6;">
          <span class="status-mark" style=${{ background: 'var(--green)', boxShadow: 'none' }} />
          已完成 <strong>${completed}</strong>
        </div>
        <div class="row" style="gap:6px;font-size:13px;opacity:0.5;">
          <span class="status-mark" style=${{ background: 'var(--red)', boxShadow: 'none' }} />
          已取消 <strong>${cancelled}</strong>
        </div>
      </div>

      ${list.length === 0 ? html`
        <div class="decisions-empty">
          <p class="decisions-empty-title">${T.dashboardPage.noDags}</p>
          <p class="decisions-empty-hint">${T.dashboardPage.noDagsHint}</p>
        </div>
      ` : list.map((d) => html`<${DagCard} key=${d.dag_id || d.id} dag=${d} />`)}
    </div>
  </${ErrorBoundary}>`;
}
