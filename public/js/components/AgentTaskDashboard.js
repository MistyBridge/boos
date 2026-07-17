// Sprint 17 A5: Agent-to-agent task timeline dashboard.
// Signal-driven, filterable, expandable — embedded in DecisionsPage.

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

const STATUS_TABS = ['all', 'pending', 'in_progress', 'completed', 'cancelled'];

function TaskCard({ task }) {
  const expanded = useSignal(false);
  const loading = useSignal(false);
  const detail = useSignal(null);
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

  const badgeClass = task.status === 'completed' ? 'approved'
    : task.status === 'cancelled' ? 'rejected' : '';
  const isUrgent = task.priority === 'high';

  return html`
    <div class="decision-card ${isUrgent ? 'is-urgent' : ''}">
      <div class="decision-card-head" onClick=${toggle}>
        <div class="decision-card-info">
          <div class="decision-card-title-row">
            <span class="decision-badge ${badgeClass}">${STATUS_LABELS[task.status] || task.status}</span>
            <span class="decision-card-title">${(task.content || '').slice(0, 80) || '(无内容)'}</span>
          </div>
          <div class="decision-card-meta">
            <span class="mono">${task.sender?.name || (task.sender?.uid || '').slice(0, 12) || '?'}</span>
            <span>→</span>
            <span class="mono">${task.receiver?.name || (task.receiver_uid || '').slice(0, 12) || '?'}</span>
            <span class="muted">· ${task.created_at ? new Date(task.created_at).toLocaleString() : ''}</span>
          </div>
        </div>
        <span class="decision-card-chevron">${expanded.value ? IconChevronDown : IconChevronRight}</span>
      </div>
      ${expanded.value ? html`
        <div class="decision-card-body">
          ${loading.value ? html`<p class="decision-loading">加载中…</p>` : null}
          ${loadError.value ? html`<p class="decision-error">${loadError.value}</p>` : null}
          ${detail.value ? html`
            <div>
              <pre class="decision-content">${detail.value.content || '(无内容)'}</pre>
              ${detail.value.result ? html`
                <div style="margin-top:var(--s-3)">
                  <strong style="font-size:12px;color:var(--ink-mid)">结果:</strong>
                  <pre class="decision-content">${typeof detail.value.result === 'string'
                    ? detail.value.result
                    : JSON.stringify(detail.value.result, null, 2)}</pre>
                </div>
              ` : null}
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

export function AgentTaskDashboard() {
  const status = useSignal('all');
  const senderFilter = useSignal('');
  const receiverFilter = useSignal('');
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

  const applyFilter = () => {
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

      <!-- Sender / Receiver filter row -->
      <div style="display:flex;gap:var(--s-2);flex-wrap:wrap;">
        <input style="border:1px solid var(--border-soft);border-radius:6px;padding:5px 10px;font-size:12px;background:var(--bg-elev);color:var(--ink);"
               placeholder="发送者筛选…" value=${senderFilter.value}
               onInput=${(e) => { senderFilter.value = e.target.value; }}
               onKeyDown=${(e) => { if (e.key === 'Enter') applyFilter(); }} />
        <input style="border:1px solid var(--border-soft);border-radius:6px;padding:5px 10px;font-size:12px;background:var(--bg-elev);color:var(--ink);"
               placeholder="接收者筛选…" value=${receiverFilter.value}
               onInput=${(e) => { receiverFilter.value = e.target.value; }}
               onKeyDown=${(e) => { if (e.key === 'Enter') applyFilter(); }} />
        <button class="action subtle" style="font-size:12px;" onClick=${applyFilter}>筛选</button>
      </div>

      <!-- Task list -->
      ${loading.value ? html`<p class="decision-loading">加载任务中…</p>` : null}
      ${!loading.value && list.length === 0 ? html`
        <div class="decisions-empty">
          <h3 class="decisions-empty-title">暂无任务</h3>
          <p class="decisions-empty-hint">Agent 间任务流将在此显示。当其他 Agent 通过 send_task 派发任务时，这里会实时更新。</p>
        </div>
      ` : null}
      <div class="decisions-list">
        ${list.map((t) => html`<${TaskCard} key=${t.task_id} task=${t} />`)}
      </div>

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
