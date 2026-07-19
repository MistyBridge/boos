// Sprint 17 A5: Agent-to-agent task timeline dashboard.
// Table view with color-coded status labels, expandable rows.

import { html } from '../html.js';
import { useSignal, useEffect } from 'preact/hooks';
import { tasks, fetchTasks, fetchTask } from '../api.js';
import { IconChevronDown, IconChevronRight } from '../icons.js';

const STATUS_LABELS = {
  all: '全部',
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

const STATUS_CLASS = {
  pending: 'task-status-pending',
  in_progress: 'task-status-active',
  completed: 'task-status-done',
  cancelled: 'task-status-cancel',
};

const STATUS_TABS = ['all', 'pending', 'in_progress', 'completed', 'cancelled'];

const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };

function truncateId(id) {
  if (!id) return '?';
  return id.length > 12 ? id.slice(0, 12) + '…' : id;
}

function TaskRow({ task }) {
  const expanded = useSignal(false);
  const detail = useSignal(null);
  const loading = useSignal(false);
  const loadError = useSignal('');

  const toggle = async () => {
    if (expanded.value) { expanded.value = false; return; }
    expanded.value = true;
    if (!detail.value) {
      loading.value = true;
      loadError.value = '';
      try {
        const full = await fetchTask(task.task_id);
        detail.value = full;
      } catch (e) {
        loadError.value = e.message || '加载失败';
      } finally {
        loading.value = false;
      }
    }
  };

  const scls = STATUS_CLASS[task.status] || '';

  return html`
    <div class="task-table-row-wrapper">
      <div class="task-table-row ${scls}" onClick=${toggle}>
        <span class="task-cell task-cell-id mono">${truncateId(task.task_id)}</span>
        <span class="task-cell task-cell-from">${task.sender?.name || (task.sender?.uid || '?').slice(0, 14)}</span>
        <span class="task-cell task-cell-to">${task.receiver?.name || (task.receiver_uid || '?').slice(0, 14)}</span>
        <span class="task-cell task-cell-status">
          <span class="task-status-chip ${scls}">${STATUS_LABELS[task.status] || task.status}</span>
        </span>
        <span class="task-cell task-cell-priority">${PRIORITY_LABEL[task.priority] || task.priority || '-'}</span>
        <span class="task-cell task-cell-time mono">${task.created_at ? new Date(task.created_at).toLocaleString() : ''}</span>
        <span class="task-cell task-cell-chevron">${expanded.value ? IconChevronDown : IconChevronRight}</span>
      </div>
      ${expanded.value ? html`
        <div class="task-row-detail">
          ${loading.value ? html`<p class="decision-loading">加载中…</p>` : null}
          ${loadError.value ? html`<p class="decision-error">${loadError.value}</p>` : null}
          ${detail.value ? html`
            <pre class="decision-content">${detail.value.content || '(无内容)'}</pre>
            ${detail.value.result ? html`
              <div style="margin-top:var(--s-3)">
                <strong style="font-size:12px;color:var(--ink-mid)">结果:</strong>
                <pre class="decision-content">${typeof detail.value.result === 'string'
                  ? detail.value.result
                  : JSON.stringify(detail.value.result, null, 2)}</pre>
              </div>
            ` : null}
          ` : null}
        </div>
      ` : null}
    </div>`;
}

export function AgentTaskDashboard() {
  const status = useSignal('all');
  const limit = useSignal(50);
  const offset = useSignal(0);
  const total = useSignal(0);
  const loading = useSignal(false);

  const load = async () => {
    loading.value = true;
    try {
      const r = await fetchTasks({
        status: status.value,
        limit: limit.value,
        offset: offset.value,
      });
      total.value = r.total || 0;
    } catch { /* endpoint may 404 */ }
    loading.value = false;
  };

  useEffect(() => { load(); }, []);

  const setStatus = (s) => {
    status.value = s;
    offset.value = 0;
    load();
  };

  const pageBack = () => {
    if (offset.value <= 0) return;
    offset.value = Math.max(0, offset.value - limit.value);
    load();
  };
  const pageForward = () => {
    if (offset.value + limit.value >= total.value) return;
    offset.value = offset.value + limit.value;
    load();
  };

  const list = tasks.value || [];

  return html`
    <div class="decisions-page">
      <!-- Status filter tabs -->
      <div class="decisions-filter">
        ${STATUS_TABS.map((s) => html`
          <button class="decision-filter-tab ${status.value === s ? 'is-active' : ''}"
                  onClick=${() => setStatus(s)}>
            ${STATUS_LABELS[s]}
          </button>
        `)}
      </div>

      <!-- Task table -->
      ${loading.value ? html`<p class="decision-loading">加载任务中…</p>` : null}
      ${!loading.value && list.length === 0 ? html`
        <div class="decisions-empty">
          <h3 class="decisions-empty-title">暂无任务</h3>
          <p class="decisions-empty-hint">Agent 间任务流将在此显示。</p>
        </div>
      ` : null}
      ${list.length > 0 ? html`
        <div class="task-table">
          <div class="task-table-head">
            <span class="task-cell task-cell-id">任务 ID</span>
            <span class="task-cell task-cell-from">发送者</span>
            <span class="task-cell task-cell-to">接收者</span>
            <span class="task-cell task-cell-status">状态</span>
            <span class="task-cell task-cell-priority">优先级</span>
            <span class="task-cell task-cell-time">时间</span>
            <span class="task-cell task-cell-chevron"></span>
          </div>
          ${list.map((t) => html`<${TaskRow} key=${t.task_id} task=${t} />`)}
        </div>
      ` : null}

      <!-- Pagination -->
      ${total.value > limit.value ? html`
        <div style="display:flex;justify-content:center;gap:var(--s-2);align-items:center;padding:var(--s-2) 0;">
          <button class="action subtle" onClick=${pageBack} disabled=${offset.value <= 0}>← 上一页</button>
          <span style="font-size:12px;color:var(--ink-muted);">
            ${offset.value + 1}–${Math.min(offset.value + limit.value, total.value)} / ${total.value}
          </span>
          <button class="action subtle" onClick=${pageForward} disabled=${offset.value + limit.value >= total.value}>下一页 →</button>
        </div>
      ` : null}
    </div>`;
}
