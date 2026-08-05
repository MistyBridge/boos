// Sprint 37: NewGoalPage — create a new goal form.
// Submits to POST /api/goals, then navigates to GoalDetailPage on success.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { workspaces } from '../state.js';
import { api, fetchGoals } from '../api.js';
import { setToast } from '../toast.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';

export function NewGoalPage({ onNavigate }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workspace, setWorkspace] = useState('boos');
  const [priority, setPriority] = useState('normal');
  const [project, setProject] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const wsList = Array.isArray(workspaces.value) ? workspaces.value : [];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('标题为必填项'); return; }
    if (!description.trim()) { setError('描述为必填项'); return; }

    setSubmitting(true);
    setError('');
    try {
      const r = await api('POST', '/api/goals', {
        title: title.trim(),
        description: description.trim(),
        workspace,
        project: project.trim() || undefined,
        priority,
        tasks: [],  // tasks added later via DAG decomposition
      });
      if (r.ok) {
        await fetchGoals();
        setToast('目标创建成功');
        const goalId = r.goal?.goal_id || r.goal?.id;
        if (onNavigate && goalId) onNavigate('goal-detail', goalId);
      } else {
        setError(r.error || '创建失败');
      }
    } catch (err) {
      setError(err.message || '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (onNavigate) onNavigate('goals');
  };

  return html`
    <${ErrorBoundary} name="NewGoalPage">
      <${PageTitleBar} title="新建目标" />
      <div class="settings-scroll">
        <form onSubmit=${handleSubmit} style="max-width:600px;">
          ${error ? html`<p class="decision-error" style="margin-bottom:var(--s-3);">${error}</p>` : null}

          <div class="field" style="margin-bottom:var(--s-3);">
            <label class="field-label" style="display:block;margin-bottom:4px;font-size:13px;color:var(--ink-mid);">
              标题 <span style="color:var(--red);">*</span>
            </label>
            <input type="text" class="text-input" value=${title}
                   onInput=${(e) => setTitle(e.target.value)}
                   placeholder="输入目标标题…" style="width:100%;" maxlength="200" />
          </div>

          <div class="field" style="margin-bottom:var(--s-3);">
            <label class="field-label" style="display:block;margin-bottom:4px;font-size:13px;color:var(--ink-mid);">
              描述 <span style="color:var(--red);">*</span>
            </label>
            <textarea class="text-input" value=${description}
                      onInput=${(e) => setDescription(e.target.value)}
                      placeholder="详细描述目标内容、预期成果…"
                      style="width:100%;min-height:120px;resize:vertical;" rows="5" />
          </div>

          <div class="field" style="margin-bottom:var(--s-3);">
            <label class="field-label" style="display:block;margin-bottom:4px;font-size:13px;color:var(--ink-mid);">优先级</label>
            <select class="text-input" value=${priority}
                    onChange=${(e) => setPriority(e.target.value)} style="width:100%;">
              <option value="high">高</option>
              <option value="normal">中</option>
              <option value="low">低</option>
            </select>
          </div>

          <div style="display:flex;gap:var(--s-3);margin-bottom:var(--s-3);">
            <div class="field" style="flex:1;">
              <label class="field-label" style="display:block;margin-bottom:4px;font-size:13px;color:var(--ink-mid);">工作区</label>
              <select class="text-input" value=${workspace}
                      onChange=${(e) => setWorkspace(e.target.value)} style="width:100%;">
                ${wsList.map((w) => html`<option key=${w.name || w} value=${w.name || w}>${w.name || w}</option>`)}
                ${wsList.length === 0 ? html`<option value="boos">boos</option>` : null}
              </select>
            </div>
            <div class="field" style="flex:1;">
              <label class="field-label" style="display:block;margin-bottom:4px;font-size:13px;color:var(--ink-mid);">项目</label>
              <input type="text" class="text-input" value=${project}
                     onInput=${(e) => setProject(e.target.value)}
                     placeholder="可选" style="width:100%;" />
            </div>
          </div>

          <div style="display:flex;gap:var(--s-2);margin-top:var(--s-4);">
            <button type="submit" class="action primary" disabled=${submitting}>
              ${submitting ? '创建中…' : '创建目标'}
            </button>
            <button type="button" class="action subtle" onClick=${handleCancel} disabled=${submitting}>
              取消
            </button>
          </div>
        </form>
      </div>
    </${ErrorBoundary}>`;
}
