// Sprint 37 Phase 4: DagTaskCard — single DAG task detail card.
// Shows title, executor, reviewer, status, retry_count, dependencies.
// Action buttons depend on user role: submit / approve / reject / reassign.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';

const STATUS = {
  pending:    { cls: 'task-status-pending', label: '待处理' },
  active:     { cls: 'task-status-active',  label: '进行中' },
  submitted:  { cls: 'task-status-pending', label: '已提交' },
  approved:   { cls: 'task-status-done',    label: '已通过' },
  rejected:   { cls: 'task-status-cancel',  label: '已驳回' },
  escalated:  { cls: 'task-status-cancel',  label: '已升级' },
};

function statusBadge(s) {
  const c = STATUS[s] || STATUS.pending;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

export function DagTaskCard({ task, currentRole }) {
  const [busy, setBusy] = useState(false);
  if (!task) return null;

  const id = task.task_id || task.id || '-';
  const deps = task.dependencies || [];
  const role = currentRole || 'viewer'; // 'executor' | 'reviewer' | 'pm' | 'viewer'

  const canSubmit  = role === 'executor' && task.status === 'active';
  const canApprove = role === 'reviewer' && task.status === 'submitted';
  const canReject  = role === 'reviewer' && task.status === 'submitted';
  const canReassign = role === 'pm';

  const doAction = async (action) => {
    setBusy(true);
    try {
      let r;
      if (action === 'submit') {
        if (!await boosConfirm('确认提交此任务？')) { setBusy(false); return; }
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/submit`);
      } else if (action === 'approve') {
        if (!await boosConfirm('确认批准此任务？')) { setBusy(false); return; }
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/approve`, { comment: '' });
      } else if (action === 'reject') {
        if (!await boosConfirm('确认驳回此任务？')) { setBusy(false); return; }
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/reject`, { comment: '驳回' });
      } else if (action === 'reassign') {
        r = await api('POST', `/api/dags/reassign`, { task_id: id });
      }
      if (r && r.ok) setToast(`${action === 'submit' ? '提交' : action === 'approve' ? '批准' : action === 'reject' ? '驳回' : '重新分配'}成功`);
      else if (r && r.error) setToast(r.error);
    } catch (e) { setToast(e.message || '操作失败'); }
    setBusy(false);
  };

  return html`
    <div class="decision-card" style="padding:var(--s-3);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--s-2);">
        <div>
          <span style="font-weight:600;font-size:14px;">${task.title || id.slice(0, 16)}</span>
          <div class="mono" style="font-size:10px;color:var(--ink-muted);">${id}</div>
        </div>
        ${statusBadge(task.status)}
      </div>

      ${task.description ? html`
        <p style="font-size:13px;color:var(--ink-mid);margin:0 0 var(--s-2);line-height:1.4;">${task.description.slice(0, 300)}</p>
      ` : null}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-1) var(--s-3);font-size:12px;color:var(--ink-mid);margin-bottom:var(--s-2);">
        <div><span style="color:var(--ink-muted);">执行者</span> ${task.executor || task.executor_name || '-'}</div>
        <div><span style="color:var(--ink-muted);">审查者</span> ${task.reviewer || task.reviewer_name || '-'}</div>
        ${task.retry_count != null ? html`<div><span style="color:var(--ink-muted);">重试次数</span> ${task.retry_count}</div>` : null}
        <div><span style="color:var(--ink-muted);">角色</span> ${role}</div>
      </div>

      ${deps.length > 0 ? html`
        <div style="font-size:12px;color:var(--ink-muted);margin-bottom:var(--s-2);">
          依赖: ${deps.map((d) => html`<span class="mono" style="font-size:10px;background:var(--bg);padding:1px 6px;border-radius:4px;margin-right:4px;">${typeof d === 'string' ? d : d.title || d.task_id}</span>`)}
        </div>
      ` : null}

      ${task.acceptance_criteria ? html`
        <div style="font-size:12px;color:var(--ink-mid);margin-bottom:var(--s-2);padding:var(--s-2);background:var(--bg);border-radius:4px;">
          <span style="color:var(--ink-muted);">验收标准</span><br/>${task.acceptance_criteria}
        </div>
      ` : null}

      <div style="display:flex;gap:var(--s-1);margin-top:var(--s-2);">
        ${canSubmit ? html`<button class="action primary" style="font-size:12px;" onClick=${() => doAction('submit')} disabled=${busy}>提交</button>` : null}
        ${canApprove ? html`<button class="action primary" style="font-size:12px;" onClick=${() => doAction('approve')} disabled=${busy}>批准</button>` : null}
        ${canReject ? html`<button class="action subtle" style="font-size:12px;" onClick=${() => doAction('reject')} disabled=${busy}>驳回</button>` : null}
        ${canReassign ? html`<button class="action subtle" style="font-size:12px;" onClick=${() => doAction('reassign')} disabled=${busy}>重新分配</button>` : null}
      </div>
    </div>`;
}
