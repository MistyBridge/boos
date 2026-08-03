// Sprint 37 Phase 4: PMInboxPanel — PM inbox panel for GoalPage sidebar.
// Shows escalated tasks, proposed nodes, and conflict notifications.
// Uses dag_list with filters. Quick decision buttons per item.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { setToast } from '../toast.js';

const TAB_KEYS = ['escalated', 'proposed', 'conflicts'];
const TAB_LABELS = { escalated: '升级', proposed: '提案', conflicts: '冲突' };

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}时`;
  return `${Math.floor(h / 24)}天`;
}

export function PMInboxPanel({ workspace }) {
  const [tab, setTab] = useState('escalated');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const filter = tab === 'escalated' ? 'escalated' : tab === 'proposed' ? 'proposed' : null;
      // Use dag_list with relevant filter.
      const r = await api('GET', `/api/dags?workspace=${encodeURIComponent(workspace || 'boos')}${filter ? `&status=${filter}` : ''}`);
      if (r && r.dags) {
        // Flatten all tasks from all DAGs matching the filter.
        const allTasks = [];
        for (const dag of r.dags) {
          const tasks = (dag.tasks || []).filter((t) => {
            if (tab === 'escalated') return t.status === 'escalated';
            if (tab === 'proposed') return t.status === 'proposed';
            if (tab === 'conflicts') return t.status === 'escalated' && t.metadata?.conflict;
            return false;
          });
          for (const t of tasks) {
            allTasks.push({ ...t, _dag_title: dag.title, _dag_id: dag.dag_id });
          }
        }
        setItems(allTasks);
      } else {
        setItems([]);
      }
    } catch { setItems([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab, workspace]);

  const handleAction = async (task, action) => {
    setBusyId(task.task_id || task.id);
    try {
      const id = task.task_id || task.id;
      let r;
      if (action === 'approve') {
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/approve`, { comment: 'PM 快速批准' });
      } else if (action === 'reject') {
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/reject`, { comment: 'PM 快速驳回' });
      } else if (action === 'resolve') {
        // Resolve escalated conflict — mark as resolved.
        r = await api('POST', `/api/dags/tasks/${encodeURIComponent(id)}/approve`, { comment: '冲突已解决' });
      }
      if (r && r.ok) {
        setToast(`${action === 'approve' ? '已批准' : action === 'reject' ? '已驳回' : '已解决'}`);
        load();
      } else if (r && r.error) {
        setToast(r.error);
      }
    } catch (e) { setToast(e.message || '操作失败'); }
    setBusyId(null);
  };

  return html`
    <div style="border-left:1px solid var(--border);padding:var(--s-3);min-width:260px;max-width:340px;height:100%;overflow-y:auto;">
      <h3 style="font-size:13px;font-weight:600;color:var(--ink);margin:0 0 var(--s-2);">PM Inbox</h3>

      <div class="decisions-filter" style="margin-bottom:var(--s-2);">
        ${TAB_KEYS.map((k) => html`
          <button class="decision-filter-tab ${tab === k ? 'is-active' : ''}" onClick=${() => setTab(k)}
                  style="font-size:11px;padding:2px 8px;">
            ${TAB_LABELS[k]}
          </button>
        `)}
      </div>

      ${loading ? html`<p class="decision-loading" style="font-size:12px;">加载中…</p>` : null}
      ${!loading && items.length === 0 ? html`
        <p style="font-size:12px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">暂无 ${TAB_LABELS[tab]} 项</p>
      ` : null}

      ${items.map((t) => {
        const id = t.task_id || t.id;
        const isBusy = busyId === id;
        return html`
          <div key=${id} style="font-size:12px;padding:var(--s-2);margin-bottom:var(--s-1);background:var(--bg);border-radius:6px;">
            <div style="font-weight:600;color:var(--ink);margin-bottom:2px;">${(t.title || id).slice(0, 30)}</div>
            <div style="color:var(--ink-muted);font-size:10px;margin-bottom:4px;">
              ${t._dag_title ? `DAG: ${t._dag_title} · ` : ''}
              ${t.executor || t.executor_name || '?'} · ${timeAgo(t.updated_at || t.created_at)}
            </div>
            ${tab === 'conflicts' && t.metadata?.conflict ? html`
              <div style="font-size:10px;color:var(--red);margin-bottom:4px;">冲突: ${t.metadata.conflict}</div>
            ` : null}
            <div style="display:flex;gap:4px;">
              ${tab === 'escalated' || tab === 'conflicts' ? html`
                <button class="action primary" style="font-size:10px;padding:1px 8px;" onClick=${() => handleAction(t, 'resolve')} disabled=${isBusy}>解决</button>
              ` : null}
              ${tab === 'proposed' ? html`
                <button class="action primary" style="font-size:10px;padding:1px 8px;" onClick=${() => handleAction(t, 'approve')} disabled=${isBusy}>批准</button>
                <button class="action subtle" style="font-size:10px;padding:1px 8px;" onClick=${() => handleAction(t, 'reject')} disabled=${isBusy}>驳回</button>
              ` : null}
            </div>
          </div>`;
      })}
    </div>`;
}
