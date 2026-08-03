// Sprint 37: GoalDetailPage — full goal detail with DAG graph + feedback timeline.
// Route: /goals/:goalId

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { getGoalDetail, startGoal, pauseGoal, archiveGoal } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { CompositeDagGraph } from '../components/CompositeDagGraph.js';

const STATUS = {
  draft:     { cls: 'task-status-pending', label: '草稿' },
  active:    { cls: 'task-status-active',  label: '进行中' },
  paused:    { cls: 'task-status-pending', label: '已暂停' },
  completed: { cls: 'task-status-done',    label: '已完成' },
  archived:  { cls: 'task-status-cancel',  label: '已归档' },
};

function statusBadge(s) {
  const c = STATUS[s] || STATUS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

export function GoalDetailPage({ goalId, onNavigate, onOpenNode }) {
  const [goal, setGoal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!goalId) { setError('缺少目标 ID'); setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const r = await getGoalDetail(goalId);
      setGoal(r.goal || r);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [goalId]);

  const handleStart = async () => {
    if (!await boosConfirm('启动目标后，PM 将开始执行关联的 DAG 任务。确定启动？')) return;
    setBusy(true);
    try {
      const r = await startGoal(goalId);
      if (r.ok) { setToast('目标已启动'); load(); }
      else { setToast(r.error || '启动失败'); }
    } catch (e) { setToast(e.message || '网络错误'); }
    setBusy(false);
  };

  const handlePause = async () => {
    if (!await boosConfirm('暂停目标后，当前执行中的任务将继续完成，但不会分配新任务。确定暂停？')) return;
    setBusy(true);
    try {
      const r = await pauseGoal(goalId);
      if (r.ok) { setToast('目标已暂停'); load(); }
      else { setToast(r.error || '暂停失败'); }
    } catch (e) { setToast(e.message || '网络错误'); }
    setBusy(false);
  };

  const handleArchive = async () => {
    if (!await boosConfirm('归档后将移入历史存档。确定归档？')) return;
    setBusy(true);
    try {
      const r = await archiveGoal(goalId);
      if (r.ok) { setToast('目标已归档'); if (onNavigate) onNavigate('goals'); }
      else { setToast(r.error || '归档失败'); }
    } catch (e) { setToast(e.message || '网络错误'); }
    setBusy(false);
  };

  const handleBack = () => { if (onNavigate) onNavigate('goals'); };

  const canStart = goal && (goal.status === 'draft' || goal.status === 'paused');
  const canPause = goal && goal.status === 'active';
  const canArchive = goal && (goal.status === 'completed' || goal.status === 'paused');

  return html`
    <${ErrorBoundary} name="GoalDetailPage">
      <${PageTitleBar} title=${goal?.title || '目标详情'} />
      <div class="settings-scroll">
        ${loading ? html`<p class="decision-loading">加载中…</p>` : null}
        ${!loading && error ? html`<p class="decision-error">${error}</p>` : null}

        ${!loading && goal ? html`
          <!-- Header -->
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--s-4);">
            <div>
              <div style="display:flex;align-items:center;gap:var(--s-2);margin-bottom:var(--s-1);">
                <button class="action subtle" onClick=${handleBack} style="font-size:12px;padding:2px 8px;">← 返回</button>
                ${statusBadge(goal.status)}
              </div>
              ${goal.description ? html`
                <p style="font-size:13px;color:var(--ink-mid);max-width:600px;line-height:1.5;">${goal.description}</p>
              ` : null}
              <div style="font-size:12px;color:var(--ink-muted);margin-top:var(--s-1);">
                工作区: ${goal.workspace || 'boos'} · 创建: ${goal.created_at ? new Date(goal.created_at).toLocaleDateString() : '-'}
                ${goal.project ? html` · 项目: ${goal.project}` : null}
              </div>
            </div>
            <div style="display:flex;gap:var(--s-2);flex-shrink:0;">
              ${canStart ? html`<button class="action primary" onClick=${handleStart} disabled=${busy}>▶ 启动</button>` : null}
              ${canPause ? html`<button class="action subtle" onClick=${handlePause} disabled=${busy}>⏸ 暂停</button>` : null}
              ${canArchive ? html`<button class="action subtle" onClick=${handleArchive} disabled=${busy}>📦 归档</button>` : null}
            </div>
          </div>

          <!-- DAG Graph -->
          <div style="margin-bottom:var(--s-4);">
            <h3 style="font-size:14px;font-weight:600;color:var(--ink);margin-bottom:var(--s-2);">
              DAG 任务图 (${(goal.dags || []).length} 个 DAG)
            </h3>
            <${CompositeDagGraph} dags=${goal.dags || []}
              onNodeClick=${(task) => onOpenNode && onOpenNode(task)} />
          </div>

          <!-- Feedback Timeline -->
          ${goal.feedback_thread && goal.feedback_thread.length > 0 ? html`
            <div>
              <h3 style="font-size:14px;font-weight:600;color:var(--ink);margin-bottom:var(--s-2);">反馈时间线</h3>
              <div class="decisions-list">
                ${goal.feedback_thread.map((fb, i) => html`
                  <div key=${i} class="decision-card" style="padding:var(--s-2);">
                    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-muted);margin-bottom:4px;">
                      <span>${fb.from || '系统'}</span>
                      <span>${fb.at ? new Date(fb.at).toLocaleString() : ''}</span>
                    </div>
                    <p style="font-size:13px;color:var(--ink-mid);margin:0;">${fb.message || fb.content || ''}</p>
                  </div>
                `)}
              </div>
            </div>
          ` : html`
            <p style="font-size:13px;color:var(--ink-muted);">暂无反馈记录。</p>
          `}
        ` : null}
      </div>
    </${ErrorBoundary}>`;
}
