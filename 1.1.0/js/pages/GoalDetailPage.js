// Sprint 37: GoalDetailPage — full goal detail with edit, DAG list,
// FeedbackTimeline integration, and status actions.
// Route: navigated from GoalListPage via onNavigate('goal-detail', goalId).

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { getGoalDetail, activateGoal, startGoal, pauseGoal, archiveGoal, updateGoal } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { FeedbackTimeline } from '../components/FeedbackTimeline.js';

// ── Constants ──────────────────────────────────────────────────────

const STATUS = {
  draft:     { cls: 'task-status-pending', label: '草稿' },
  active:    { cls: 'task-status-active',  label: '进行中' },
  paused:    { cls: 'task-status-pending', label: '已暂停' },
  completed: { cls: 'task-status-done',    label: '已完成' },
  archived:  { cls: 'task-status-cancel',  label: '已归档' },
};

const PRIORITY = { high: '高', normal: '中', low: '低' };

function statusBadge(s) {
  const c = STATUS[s] || STATUS.draft;
  return html`<span class="task-status-chip ${c.cls}">${c.label}</span>`;
}

function priorityBadge(p) {
  const label = PRIORITY[p] || PRIORITY.normal;
  const bg = p === 'high' ? '#f8d7da' : p === 'low' ? '#f0f0f0' : '#fff3cd';
  const color = p === 'high' ? '#58151c' : p === 'low' ? '#555' : '#664d03';
  return html`<span style="font-size:10px;padding:1px 8px;border-radius:999px;background:${bg};color:${color};font-weight:500;">${label}</span>`;
}

function taskProgress(tasks) {
  if (!tasks || tasks.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = tasks.filter((t) => t.status === 'completed' || t.status === 'done').length;
  return { done, total: tasks.length, pct: Math.round((done / tasks.length) * 100) };
}

// ── Edit form inline ───────────────────────────────────────────────

function EditForm({ goal, onSave, onCancel, busy }) {
  const [title, setTitle] = useState(goal.title || '');
  const [description, setDescription] = useState(goal.description || '');
  const [priority, setPriority] = useState(goal.priority || 'normal');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ title: title.trim(), description: description.trim(), priority });
  };

  return html`
    <form onSubmit=${handleSubmit} style="padding:var(--s-3);background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:var(--s-3);">
      <div style="margin-bottom:var(--s-2);">
        <label style="font-size:11px;font-weight:600;color:var(--ink-muted);display:block;margin-bottom:2px;">标题</label>
        <input class="field" style="width:100%;box-sizing:border-box;" value=${title}
               onInput=${(e) => setTitle(e.target.value)} required />
      </div>
      <div style="margin-bottom:var(--s-2);">
        <label style="font-size:11px;font-weight:600;color:var(--ink-muted);display:block;margin-bottom:2px;">描述</label>
        <textarea class="field" style="width:100%;box-sizing:border-box;min-height:80px;resize:vertical;"
                  value=${description} onInput=${(e) => setDescription(e.target.value)} />
      </div>
      <div style="margin-bottom:var(--s-3);">
        <label style="font-size:11px;font-weight:600;color:var(--ink-muted);display:block;margin-bottom:2px;">优先级</label>
        <select class="field" value=${priority} onChange=${(e) => setPriority(e.target.value)}>
          <option value="high">高</option>
          <option value="normal">中</option>
          <option value="low">低</option>
        </select>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="action primary small" type="submit" disabled=${busy || !title.trim()}>
          ${busy ? '保存中…' : '保存'}
        </button>
        <button class="action subtle small" type="button" onClick=${onCancel} disabled=${busy}>取消</button>
      </div>
    </form>`;
}

// ── Page ───────────────────────────────────────────────────────────

export function GoalDetailPage({ goalId, onNavigate, onOpenNode }) {
  const [goal, setGoal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!goalId) { setError('缺少目标 ID'); setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const r = await getGoalDetail(goalId);
      setGoal(r.goal || r);
    } catch (e) { setError(e.message || '加载失败'); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [goalId]);

  // ── actions ──

  async function doAction(fn, label, confirmMsg) {
    if (busy) return;
    if (confirmMsg) {
      const ok = await boosConfirm(confirmMsg);
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fn(goalId);
      if (r && r.ok) { setToast(label); load(); }
      else if (r && r.error) { setToast(r.error, 'error'); }
    } catch (e) { setToast(e.message || '操作失败', 'error'); }
    setBusy(false);
  }

  async function handleEditSave(data) {
    setBusy(true);
    try {
      const r = await updateGoal(goalId, data);
      if (r && r.ok) { setToast('已更新'); setEditing(false); load(); }
      else if (r && r.error) { setToast(r.error, 'error'); }
    } catch (e) { setToast(e.message || '操作失败', 'error'); }
    setBusy(false);
  }

  const handleBack = () => { if (onNavigate) onNavigate('goals'); };

  const s = goal?.status;
  const canActivate = s === 'draft';
  const canStart    = s === 'draft' || s === 'paused';
  const canPause    = s === 'active';
  const canArchive  = s === 'completed' || s === 'paused';

  const progress = taskProgress(goal?.tasks || []);
  const dags = Array.isArray(goal?.dags) ? goal.dags : [];
  const feedback = Array.isArray(goal?.feedback) ? goal.feedback : (goal?.feedback_thread || []);

  return html`
    <${ErrorBoundary} name="GoalDetailPage">
      <${PageTitleBar} title=${goal?.title || '目标详情'} />

      <div class="decisions-page">
        ${loading ? html`<p class="decision-loading">加载中…</p>` : null}
        ${!loading && error ? html`<p style="color:var(--red);padding:var(--s-3);">${error}</p>` : null}

        ${!loading && goal ? html`
          <!-- header -->
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--s-3);flex-wrap:wrap;gap:var(--s-2);">
            <div style="flex:1;min-width:200px;">
              <div style="display:flex;align-items:center;gap:var(--s-2);margin-bottom:var(--s-1);flex-wrap:wrap;">
                <button class="action subtle small" onClick=${handleBack} style="font-size:12px;padding:2px 8px;">返回</button>
                ${statusBadge(s)}
                ${priorityBadge(goal.priority)}
              </div>
              ${goal.description ? html`
                <p style="font-size:13px;color:var(--ink-mid);max-width:600px;line-height:1.5;margin:0;">${goal.description}</p>
              ` : null}
              <div style="font-size:12px;color:var(--ink-muted);margin-top:4px;display:flex;gap:var(--s-3);flex-wrap:wrap;">
                <span>工作区: ${goal.workspace || 'boos'}</span>
                ${goal.created_at ? html`<span>创建: ${new Date(goal.created_at).toLocaleDateString()}</span>` : null}
                ${goal.updated_at ? html`<span>更新: ${new Date(goal.updated_at).toLocaleDateString()}</span>` : null}
              </div>
            </div>

            <!-- action buttons -->
            <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;">
              <button class="action subtle small" onClick=${() => setEditing(!editing)}
                      style="font-size:12px;padding:4px 12px;" disabled=${busy}>
                ${editing ? '取消编辑' : '编辑'}
              </button>
              ${canActivate ? html`
                <button class="action primary small" onClick=${() => doAction(activateGoal, '已激活', null)}
                        style="font-size:12px;padding:4px 12px;" disabled=${busy}>激活</button>
              ` : null}
              ${canStart ? html`
                <button class="action primary small" onClick=${() => doAction(startGoal, '已启动', '启动目标后 PM 将开始执行关联的 DAG 任务。')}
                        style="font-size:12px;padding:4px 12px;" disabled=${busy}>启动</button>
              ` : null}
              ${canPause ? html`
                <button class="action subtle small" onClick=${() => doAction(pauseGoal, '已暂停', '暂停目标？执行中的任务将继续完成。')}
                        style="font-size:12px;padding:4px 12px;" disabled=${busy}>暂停</button>
              ` : null}
              ${canArchive ? html`
                <button class="action subtle small" onClick=${() => doAction(archiveGoal, '已归档', '归档此目标？')}
                        style="font-size:12px;padding:4px 12px;" disabled=${busy}>归档</button>
              ` : null}
            </div>
          </div>

          <!-- edit form -->
          ${editing ? html`
            <${EditForm} goal=${goal} onSave=${handleEditSave} onCancel=${() => setEditing(false)} busy=${busy} />
          ` : null}

          <!-- progress -->
          ${progress.total > 0 ? html`
            <div style="margin-bottom:var(--s-3);padding:var(--s-2) var(--s-3);background:var(--bg);border-radius:8px;border:1px solid var(--border);">
              <div style="display:flex;align-items:center;gap:var(--s-2);">
                <span style="font-size:12px;font-weight:500;color:var(--ink);">任务进度</span>
                <div style="flex:1;height:6px;background:var(--border);border-radius:999px;overflow:hidden;">
                  <div style="width:${progress.pct}%;height:100%;background:${progress.pct >= 100 ? 'var(--green)' : '#4a73a5'};border-radius:999px;transition:width .3s ease;" />
                </div>
                <span style="font-size:11px;color:var(--ink-muted);font-variant-numeric:tabular-nums;">${progress.done}/${progress.total} · ${progress.pct}%</span>
              </div>
            </div>
          ` : null}

          <!-- DAG list -->
          <div style="margin-bottom:var(--s-3);">
            <h3 style="font-size:14px;font-weight:600;color:var(--ink);margin:0 0 var(--s-2);">
              关联 DAG (${dags.length})
            </h3>
            ${dags.length === 0 ? html`
              <p style="font-size:12px;color:var(--ink-muted);">暂无关联 DAG。</p>
            ` : html`
              <div style="display:flex;flex-direction:column;gap:var(--s-1);">
                ${dags.map((dag) => html`
                  <div key=${dag.dag_id || dag.id} class="decision-card" style="padding:var(--s-2);font-size:12px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style="font-weight:500;color:var(--ink);">${dag.title || dag.name || dag.dag_id || '?'}</span>
                      <span class="task-status-chip ${(dag.status === 'active' ? 'task-status-active' : dag.status === 'completed' ? 'task-status-done' : 'task-status-pending')}"
                            style="font-size:10px;">${dag.status || 'pending'}</span>
                      <span style="color:var(--ink-muted);margin-left:auto;">${(dag.tasks || []).length} 任务</span>
                    </div>
                  </div>
                `)}
              </div>
            `}
          </div>

          <!-- Feedback timeline -->
          <div>
            <h3 style="font-size:14px;font-weight:600;color:var(--ink);margin:0 0 var(--s-2);">反馈时间线</h3>
            <${FeedbackTimeline} feedback=${feedback} />
          </div>
        ` : null}
      </div>
    </${ErrorBoundary}>`;
}
