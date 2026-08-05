// Sprint 37 Phase 4C: PMInboxPanel — settlement notification inbox for PM.
// Auto-polls settlement tasks every 30s. Sorted by priority (high > normal > low).
// Expand to view full content. Approve/reject via settleTask API.

import { html } from '../html.js';
import { useEffect, useState, useRef } from 'preact/hooks';
import { fetchSettlementNotifications, settleTask } from '../api.js';
import { setToast } from '../toast.js';

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
const PRIORITY_LABELS = { high: '高', normal: '中', low: '低' };
const PRIORITY_STYLES = {
  high:   'background:#f8d7da;color:#58151c;',
  normal: 'background:#fff3cd;color:#664d03;',
  low:    'background:#f0f0f0;color:#555;',
};

const POLL_INTERVAL = 30_000;

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

function sortByPriority(items) {
  return [...items].sort((a, b) =>
    (PRIORITY_ORDER[a.priority || 'normal'] || 1) -
    (PRIORITY_ORDER[b.priority || 'normal'] || 1)
  );
}

export function PMInboxPanel({ workspace }) {
  const [notifications, setNotifications] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const timerRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchSettlementNotifications(workspace || 'boos');
      const tasks = (r && r.tasks) ? r.tasks.filter((t) => t.matched_via === 'settlement') : [];
      setNotifications(sortByPriority(tasks));
    } catch { /* keep previous list on error */ }
    setLoading(false);
  };

  // Initial load + 30s auto-poll
  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [workspace]);

  const handleSettle = async (task, action) => {
    const taskId = task.task_id || task.id;
    setBusyId(taskId);
    try {
      const feedback = action === 'reject' ? (prompt('驳回原因（可选）:') || '已驳回') : '已批准';
      const r = await settleTask(taskId, action, feedback);
      if (r && r.ok) {
        setToast(action === 'approve' ? '已审核通过' : '已驳回');
        // Remove settled item from list immediately
        setNotifications((prev) => prev.filter((n) => (n.task_id || n.id) !== taskId));
        setExpandedId(null);
      } else if (r && r.error) {
        setToast(r.error);
      }
    } catch (e) { setToast(e.message || '操作失败'); }
    setBusyId(null);
  };

  const toggleExpand = (taskId) => {
    setExpandedId((prev) => prev === taskId ? null : taskId);
  };

  const hasNotifications = notifications.length > 0;

  return html`
    <div style="border-left:1px solid var(--border);padding:var(--s-3);min-width:260px;max-width:340px;height:100%;overflow-y:auto;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-2);">
        <h3 style="font-size:13px;font-weight:600;color:var(--ink);margin:0;">PM 收件箱</h3>
        ${notifications.length > 0 ? html`
          <span style="font-size:10px;color:var(--ink-muted);background:var(--bg-elev);padding:1px 6px;border-radius:999px;border:1px solid var(--border);font-variant-numeric:tabular-nums;">${notifications.length}</span>
        ` : null}
      </div>

      ${loading && !hasNotifications ? html`
        <p style="font-size:12px;color:var(--ink-muted);text-align:center;padding:var(--s-4);">加载中…</p>
      ` : null}

      ${!loading && !hasNotifications ? html`
        <div style="flex:1;display:flex;align-items:center;justify-content:center;">
          <p style="font-size:12px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">暂无待审核任务</p>
        </div>
      ` : null}

      ${notifications.map((t) => {
        const taskId = t.task_id || t.id;
        const isExpanded = expandedId === taskId;
        const isBusy = busyId === taskId;
        const pStyle = PRIORITY_STYLES[t.priority] || PRIORITY_STYLES.normal;

        return html`
          <div key=${taskId}
               style="font-size:12px;padding:var(--s-2);margin-bottom:var(--s-1);background:var(--bg);border-radius:6px;border:1px solid var(--border);cursor:pointer;"
               onClick=${() => toggleExpand(taskId)}>

            <!-- Summary row -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${t.sender?.name || t.sender_name || '未知'}
                </div>
                <div style="color:var(--ink-muted);font-size:10px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${(taskId || '').slice(0, 14)}
                </div>
              </div>
              <span style="font-size:10px;padding:1px 6px;border-radius:999px;flex-shrink:0;${pStyle}">
                ${PRIORITY_LABELS[t.priority] || '中'}
              </span>
            </div>

            <div style="color:var(--ink-muted);font-size:10px;margin-top:2px;">
              ${timeAgo(t.created_at || t.updated_at)}
            </div>

            <!-- Expanded detail -->
            ${isExpanded ? html`
              <div style="margin-top:var(--s-2);padding-top:var(--s-2);border-top:1px solid var(--border);">
                <div style="font-size:12px;color:var(--ink);line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;">
                  ${t.content || t.message || '(无内容)'}
                </div>
                <div style="font-size:10px;color:var(--ink-muted);margin-top:var(--s-1);">
                  任务: <span style="font-family:var(--font-mono);">${(taskId || '').slice(0, 20)}</span>
                </div>
                <div style="display:flex;gap:6px;margin-top:var(--s-2);" onClick=${(e) => e.stopPropagation()}>
                  <button class="action primary" style="font-size:11px;padding:2px 12px;"
                          onClick=${() => handleSettle(t, 'approve')} disabled=${isBusy}>
                    ${isBusy ? '处理中…' : '审核通过'}
                  </button>
                  <button class="action danger" style="font-size:11px;padding:2px 12px;"
                          onClick=${() => handleSettle(t, 'reject')} disabled=${isBusy}>
                    驳回
                  </button>
                </div>
              </div>
            ` : null}
          </div>`;
      })}
    </div>`;
}
