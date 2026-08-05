// Sprint 37 Phase 4: DagDecomposeView — batch DAG decomposition preview UI.
// 1. User describes the goal → calls dag_decompose → shows preview
// 2. User reviews/edits task list → confirms → batch creates via dag_create + dag_add_task
// 3. On success shows created DAG IDs.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { decomposeDag, api } from '../api.js';
import { setToast } from '../toast.js';

const PRIORITY_OPTS = ['normal', 'high', 'low'];

export function DagDecomposeView({ goalId, workspace, onDone }) {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);  // { summary, dag_id, tasks[] }
  const [tasks, setTasks] = useState([]);        // editable task list
  const [autoActivate, setAutoActivate] = useState(true);
  const [creating, setCreating] = useState(false);

  const canDecompose = description.trim().length >= 10 && !loading;

  // Step 1: decompose
  const handleDecompose = async () => {
    setLoading(true);
    try {
      const r = await decomposeDag({
        title: description.trim().split('\n')[0].slice(0, 80),
        description: description.trim(),
        workspace: workspace || 'boos',
        tasks: [],  // let the backend generate task suggestions
        auto_activate: false, // preview only, don't activate yet
      });
      if (r && r.ok) {
        setPreview(r);
        setTasks(r.tasks || r.suggested_tasks || []);
        setToast(`拆解完成 — ${(r.tasks || r.suggested_tasks || []).length} 个任务`);
      } else {
        setToast(r?.error || '拆解失败');
      }
    } catch (e) { setToast(e.message || '拆解请求失败'); }
    setLoading(false);
  };

  // Step 2: edit a task field
  const updateTask = (idx, field, value) => {
    const next = [...tasks];
    next[idx] = { ...next[idx], [field]: value };
    setTasks(next);
  };

  // Step 3: confirm and batch create
  const handleConfirm = async () => {
    if (tasks.length === 0) { setToast('任务列表为空'); return; }
    setCreating(true);
    try {
      const r = await decomposeDag({
        title: description.trim().split('\n')[0].slice(0, 80),
        description: description.trim(),
        workspace: workspace || 'boos',
        tasks: tasks.map((t) => ({
          title: t.title,
          description: t.description || '',
          executor: t.executor || t.executor_name || '',
          reviewer: t.reviewer || t.reviewer_name || '',
          acceptance_criteria: t.acceptance_criteria || '',
          priority: t.priority || 'normal',
          dependencies: t.dependencies || [],
        })),
        auto_activate: autoActivate,
      });
      if (r && r.ok) {
        setToast(`DAG 创建成功${autoActivate ? '并已激活' : '（草稿）'}`);
        if (onDone) onDone(r);
      } else {
        setToast(r?.error || '批量创建失败');
      }
    } catch (e) { setToast(e.message || '创建失败'); }
    setCreating(false);
  };

  return html`
    <div style="max-width:720px;">
      <!-- Step 1: input -->
      <div style="margin-bottom:var(--s-4);">
        <label style="display:block;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:var(--s-1);">
          DAG 拆分描述
        </label>
        <textarea class="text-input" value=${description}
                  onInput=${(e) => setDescription(e.target.value)}
                  placeholder="描述你的目标，系统将自动拆分为 DAG 任务。例如：&#10;1. 设计 API 接口&#10;2. 实现后端逻辑&#10;3. 前端页面开发&#10;4. 集成测试"
                  rows="5" style="width:100%;resize:vertical;"
                  disabled=${loading || creating} />
        <div style="margin-top:var(--s-2);display:flex;gap:var(--s-2);align-items:center;">
          <button class="action primary" onClick=${handleDecompose} disabled=${!canDecompose}>
            ${loading ? '拆分中…' : '🔍 预览拆解'}
          </button>
          <span style="font-size:11px;color:var(--ink-muted);">至少 10 个字符</span>
        </div>
      </div>

      <!-- Step 2: preview + edit -->
      ${preview ? html`
        <div style="margin-bottom:var(--s-4);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--s-2);">
            <h3 style="font-size:14px;font-weight:600;color:var(--ink);margin:0;">
              任务预览 (${tasks.length} 个)
            </h3>
            <label style="font-size:12px;color:var(--ink-mid);display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" checked=${autoActivate} onChange=${(e) => setAutoActivate(e.target.checked)} />
              创建后自动激活
            </label>
          </div>

          ${preview.summary ? html`
            <div style="font-size:12px;color:var(--ink-muted);margin-bottom:var(--s-2);padding:var(--s-2);background:var(--bg);border-radius:6px;">
              ${preview.summary}
            </div>
          ` : null}

          <div style="display:flex;flex-direction:column;gap:var(--s-2);">
            ${tasks.map((t, i) => html`
              <div key=${i} style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:var(--s-2);">
                <div style="display:flex;gap:var(--s-2);align-items:flex-start;">
                  <span style="font-weight:600;font-size:12px;color:var(--ink-muted);min-width:20px;">${i + 1}.</span>
                  <div style="flex:1;display:flex;flex-direction:column;gap:var(--s-1);">
                    <input type="text" class="text-input" value=${t.title || ''}
                           onInput=${(e) => updateTask(i, 'title', e.target.value)}
                           placeholder="任务标题" style="font-size:13px;font-weight:600;" />
                    <input type="text" class="text-input" value=${t.description || ''}
                           onInput=${(e) => updateTask(i, 'description', e.target.value)}
                           placeholder="描述（可选）" style="font-size:12px;" />
                    <div style="display:flex;gap:var(--s-1);">
                      <input type="text" class="text-input" value=${t.executor || t.executor_name || ''}
                             onInput=${(e) => updateTask(i, 'executor', e.target.value)}
                             placeholder="执行者" style="flex:1;font-size:12px;" />
                      <input type="text" class="text-input" value=${t.reviewer || t.reviewer_name || ''}
                             onInput=${(e) => updateTask(i, 'reviewer', e.target.value)}
                             placeholder="审查者" style="flex:1;font-size:12px;" />
                      <select class="text-input" value=${t.priority || 'normal'}
                              onChange=${(e) => updateTask(i, 'priority', e.target.value)}
                              style="font-size:12px;width:80px;">
                        ${PRIORITY_OPTS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            `)}
          </div>
        </div>

        <!-- Step 3: confirm -->
        <div style="display:flex;gap:var(--s-2);">
          <button class="action primary" onClick=${handleConfirm} disabled=${creating || tasks.length === 0}>
            ${creating ? '创建中…' : `创建 DAG (${tasks.length} 任务)${autoActivate ? ' + 激活' : ''}`}
          </button>
          <button class="action subtle" onClick=${() => { setPreview(null); setTasks([]); }}>
            重置
          </button>
        </div>
      ` : null}

      ${preview?.resolution_report ? html`
        <div style="margin-top:var(--s-3);padding:var(--s-2);background:var(--bg);border-radius:6px;font-size:12px;color:var(--ink-muted);">
          <strong>拆解报告:</strong> ${preview.resolution_report}
        </div>
      ` : null}
    </div>`;
}
