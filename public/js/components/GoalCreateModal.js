// Sprint 37 Phase 4: GoalCreateModal — modal form for creating a new Goal.
// Fields: title, description, parent_goal_id (dropdown from active goals).
// Calls goal_create via POST /api/goals. Reuses existing <Modal> component.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { goals } from '../state.js';
import { api, fetchGoals } from '../api.js';
import { setToast } from '../toast.js';
import { Modal } from './Modal.js';
import { T } from '../i18n.js';

export function GoalCreateModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [parentGoalId, setParentGoalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const goalList = Array.isArray(goals.value) ? goals.value : [];
  const parentCandidates = goalList.filter((g) => g.status !== 'archived');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('请输入目标标题'); return; }
    if (!description.trim()) { setError('请输入目标描述'); return; }
    setError('');
    setBusy(true);
    try {
      const r = await api('POST', '/api/goals', {
        title: title.trim(),
        description: description.trim(),
        workspace: 'boos',
        parent_goal_id: parentGoalId || undefined,
        tasks: [],
      });
      if (r && r.ok) {
        setToast('目标已创建');
        await fetchGoals();
        if (onCreated) onCreated(r.goal);
      } else if (r && r.error) {
        setError(r.error);
      }
    } catch (err) { setError(err.message || '创建失败'); }
    setBusy(false);
  };

  return html`
    <${Modal} onClose=${onClose} title=${T.goalsPage?.createTitle || '新建目标'}>
      <form onSubmit=${handleSubmit} style="display:flex;flex-direction:column;gap:var(--s-3);min-width:360px;">
        ${error ? html`<p class="decision-error" style="margin:0;">${error}</p>` : null}

        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          目标标题 <span style="color:var(--red);">*</span>
          <input type="text" value=${title} onInput=${(e) => setTitle(e.target.value)}
                 placeholder="例：完成 BOOS v1.2 版本发布"
                 style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;"
                 disabled=${busy} autoFocus />
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          描述 <span style="color:var(--red);">*</span>
          <textarea value=${description} onInput=${(e) => setDescription(e.target.value)}
                    placeholder="目标的详细描述…"
                    rows="3"
                    style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;resize:vertical;"
                    disabled=${busy} />
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          父目标（可选）
          <select value=${parentGoalId}
                  onChange=${(e) => setParentGoalId(e.target.value)}
                  style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;"
                  disabled=${busy}>
            <option value="">无（顶级目标）</option>
            ${parentCandidates.map((g) => html`
              <option key=${g.goal_id || g.id} value=${g.goal_id || g.id}>${g.title}</option>
            `)}
          </select>
        </label>

        <div style="display:flex;gap:var(--s-2);justify-content:flex-end;margin-top:var(--s-1);">
          <button type="button" class="action subtle" onClick=${onClose} disabled=${busy}>取消</button>
          <button type="submit" class="action primary" disabled=${busy || !title.trim() || !description.trim()}>
            ${busy ? '创建中…' : '创建目标'}
          </button>
        </div>
      </form>
    </${Modal}>`;
}
