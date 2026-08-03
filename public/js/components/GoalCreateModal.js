// Sprint 37: GoalCreateModal — modal form for creating a new Goal.
// Triggered from GoalListPage's "+ 新建目标" button.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { setToast } from '../toast.js';
import { Modal } from './Modal.js';
import { T } from '../i18n.js';

export function GoalCreateModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [parentGoalId, setParentGoalId] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setToast('请输入目标标题'); return; }
    setBusy(true);
    try {
      const { api } = await import('../api.js');
      const r = await api('POST', '/api/goals', {
        title: title.trim(),
        description: description.trim(),
        parent_goal_id: parentGoalId.trim() || undefined,
      });
      if (r && r.ok) {
        setToast('目标已创建');
        if (onCreated) onCreated(r.goal);
      } else if (r && r.error) {
        setToast(r.error);
      }
    } catch (err) { setToast(err.message || '创建失败'); }
    setBusy(false);
  };

  return html`
    <${Modal} onClose=${onClose} title=${T.goalsPage?.createTitle || '新建目标'}>
      <form onSubmit=${handleSubmit} style="display:flex;flex-direction:column;gap:var(--s-3);min-width:360px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          目标标题 *
          <input type="text" value=${title} onInput=${(e) => setTitle(e.target.value)}
                 placeholder="例：完成 BOOS v1.2 版本发布"
                 style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;"
                 disabled=${busy} autoFocus />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          描述
          <textarea value=${description} onInput=${(e) => setDescription(e.target.value)}
                    placeholder="目标的详细描述..."
                    rows="3"
                    style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;resize:vertical;"
                    disabled=${busy} />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-mid);">
          父目标 ID (可选)
          <input type="text" value=${parentGoalId} onInput=${(e) => setParentGoalId(e.target.value)}
                 placeholder="留空则创建为顶层目标"
                 style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;"
                 disabled=${busy} />
        </label>
        <div style="display:flex;gap:var(--s-2);justify-content:flex-end;margin-top:var(--s-1);">
          <button type="button" class="action subtle" onClick=${onClose} disabled=${busy}>取消</button>
          <button type="submit" class="action primary" disabled=${busy || !title.trim()}>
            ${busy ? '创建中…' : '创建目标'}
          </button>
        </div>
      </form>
    </${Modal}>`;
}
