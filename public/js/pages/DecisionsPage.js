// DecisionsPage — review and approve/reject decisions proposed by AI agents.
// Card list with filter tabs (Open / Decided / All), expand to read full
// Markdown content, approve (green) / reject (red) action buttons.

import { html } from '../html.js';
import { useEffect, useState, useRef } from 'preact/hooks';
import { decisions, config } from '../state.js';
import { fetchDecisions, getDecisionContent, approveDecision, rejectDecision, replyDecision, respondRootTask } from '../api.js';
import { setToast } from '../toast.js';
import { boosPrompt } from '../dialog.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { T } from '../i18n.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';

const FILTER_TABS = [
  { key: 'open',    label: T.decisionsPage.open },
  { key: 'decided', label: T.decisionsPage.decided },
  { key: 'all',     label: T.decisionsPage.all },
];

// ── read-tracking (localStorage) ────────────────────────────────────
const LS_READ_KEY = 'boos.decisions-read-ids';
function loadReadIds() {
  try {
    const raw = localStorage.getItem(LS_READ_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveReadIds(ids) { try { localStorage.setItem(LS_READ_KEY, JSON.stringify([...ids])); } catch {} }

// ── batch merge: group same-agent decisions within 10 min window ────
function mergeDecisions(list) {
  if (!list || list.length < 2) return (list || []).map((d) => ({ type: 'single', ...d }));
  const result = [];
  let group = null;
  for (const d of list) {
    const agent = d.agent_name || 'unknown';
    const ts = new Date(d.created_at).getTime();
    if (group && group.agent === agent && (ts - group.lastTs <= 10 * 60 * 1000)) {
      group.items.push(d);
      group.count++;
      group.lastTs = ts;
    } else {
      if (group) result.push(group);
      group = { type: 'group', agent, items: [d], count: 1, firstTs: ts, lastTs: ts };
    }
  }
  if (group) result.push(group);
  return result;
}

function DecisionCard({ d, onApprove, onReject, onReply, busy, isRead }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [replyText, setReplyText] = useState('');

  const onToggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await getDecisionContent(d.decision_id);
      setContent(r.content || '');
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const isOpen = d.status === 'open';
  const isUrgent = d.urgent;
  const ts = d.created_at ? new Date(d.created_at).getTime() : 0;

  return html`
    <div class=${`decision-card${expanded ? ' is-expanded' : ''}${isUrgent ? ' is-urgent' : ''}${isRead ? ' is-read' : ''}`}>
      <div class="decision-card-head" onClick=${onToggle}>
        <div class="decision-card-info">
          <div class="decision-card-title-row">
            <span class="decision-card-title">${d.title || '未命名决策'}</span>
            ${isUrgent ? html`<span class="decision-badge urgent">${T.decisionsPage.urgent}</span>` : null}
            ${!isOpen ? html`
              <span class=${`decision-badge ${d.status === 'approved' ? 'approved' : 'rejected'}`}>
                ${d.status === 'approved' ? T.decisionsPage.approved : T.decisionsPage.rejected}
              </span>
            ` : null}
          </div>
          <div class="decision-card-meta">
            <span>${T.decisionsPage.byAgent(d.agent_name || 'unknown')}</span>
            ${d.workspace ? html`<span> · ${T.decisionsPage.inWorkspace(d.workspace)}</span>` : null}
            ${ts > 0 ? html`<span> · ${fmtAgo(ts)}</span>` : null}
          </div>
        </div>
        <div class="decision-card-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               style=${{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>
      ${expanded ? html`
        <div class="decision-card-body">
          ${loading ? html`
            <p class="decision-loading">${T.decisionsPage.loadingContent}</p>
          ` : loadError ? html`
            <p class="decision-error">${T.decisionsPage.loadContentFailed}${loadError}</p>
          ` : content ? html`
            <pre class="decision-content">${content}</pre>
          ` : null}
          ${isOpen ? html`
            <div class="decision-card-reply">
              <textarea class="decision-reply-input"
                        placeholder="输入回复…" rows="2"
                        onInput=${(ev) => setReplyText(ev.target.value)}
                        value=${replyText}>
              </textarea>
              <div class="decision-card-reply-actions">
                <button class="action small primary"
                        onClick=${(ev) => { ev.stopPropagation(); onReply(d, replyText); }}
                        disabled=${!replyText.trim() || busy}>
                  发送
                </button>
              </div>
            </div>
            <div class="decision-card-actions">
              <button class="action primary decision-approve"
                      onClick=${(ev) => { ev.stopPropagation(); onApprove(d); }}>
                ${T.decisionsPage.approve}
              </button>
              <button class="action danger decision-reject"
                      onClick=${(ev) => { ev.stopPropagation(); onReject(d); }}>
                ${T.decisionsPage.reject}
              </button>
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

// RootTaskCard — card for root agent inbox tasks (from agent_root).
// Click to expand and reply directly.
function RootTaskCard({ task, onRespond, busy }) {
  const [expanded, setExpanded] = useState(false);
  const [replyText, setReplyText] = useState('');
  const preview = (task.content || '').slice(0, 120);

  return html`
    <div class=${`decision-card root-task-card${expanded ? ' is-expanded' : ''}`}
         onClick=${() => setExpanded(!expanded)}>
      <div class="decision-card-head">
        <div class="decision-card-title-row">
          <span class="root-badge">📨 ${task.sender_name || 'Agent'}</span>
          ${task.priority === 'high' ? html`<span class="decision-badge urgent">紧急</span>` : null}
        </div>
        <div class="decision-card-meta">
          ${preview}${task.content && task.content.length > 120 ? '…' : ''}
        </div>
      </div>
      ${expanded ? html`
        <div class="decision-card-body" onClick=${(e) => e.stopPropagation()}>
          <pre class="decision-content">${task.content}</pre>
          <div class="decision-card-reply">
            <textarea class="decision-reply-input" placeholder="输入回复…" rows="2"
                      onInput=${(ev) => setReplyText(ev.target.value)}
                      value=${replyText} />
            <div class="decision-card-reply-actions">
              <button class="action small primary"
                      onClick=${() => onRespond(task, replyText.trim() || '✅ 已确认')}
                      disabled=${busy}>回复</button>
            </div>
          </div>
          <div class="decision-card-actions">
            <button class="action primary" onClick=${() => onRespond(task, '✅ 已确认')}>✅ 确认</button>
            <button class="action danger" onClick=${() => onRespond(task, '❌ 已拒绝')}>❌ 拒绝</button>
          </div>
        </div>` : null}
    </div>`;
}

// DecisionGroup — collapsible batch of decisions from the same agent
// within a 10-minute window.
function DecisionGroup({ group, isRead, onApprove, onReject, onReply, busy }) {
  const [expanded, setExpanded] = useState(false);
  const firstTs = group.firstTs ? new Date(group.firstTs).getTime() : 0;
  const openCount = group.items.filter((d) => d.status === 'open').length;
  const readCount = group.items.filter((d) => isRead(d.decision_id)).length;
  return html`
    <div class=${`decision-group${expanded ? ' is-expanded' : ''}`}>
      <div class="decision-group-head" onClick=${() => setExpanded(!expanded)}>
        <span class="decision-group-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               style=${{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
        <span class="decision-group-info">
          <span class="decision-group-title">${group.agent} · ${group.count} 条决策</span>
          <span class="decision-group-meta">
            ${openCount > 0 ? html`<span>${openCount} 条待处理</span>` : null}
            ${firstTs > 0 ? html`<span> · ${isNaN(firstTs) ? '' : 'some time ago'}</span>` : null}
          </span>
        </span>
      </div>
      ${expanded ? html`
        <div class="decision-group-body">
          ${group.items.map((d) => html`
            <${DecisionCard} key=${d.decision_id} d=${d}
              isRead=${isRead(d.decision_id)}
              onApprove=${onApprove} onReject=${onReject} onReply=${onReply} busy=${busy} />
          `)}
        </div>
      ` : null}
    </div>`;
}

export function DecisionsPage() {
  clockTick.value; // subscribe for fmtAgo refresh
  const [filter, setFilter] = useState('open');
  const [busy, setBusy] = useState(false);
  const [readIds, setReadIds] = useState(() => loadReadIds());
  const pollRef = useRef(null);
  const list = decisions.value;

  // ── Root Agent Inbox state ────────────────────────────────────────
  const [rootInbox, setRootInbox] = useState([]);
  const rootProcessedRef = useRef(new Set());
  const merged = mergeDecisions(list);

  // Fetch on mount + filter change.
  useEffect(() => {
    fetchDecisions(filter).catch(() => {});
  }, [filter]);

  // Poll every 10s when idle for auto-refresh.
  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchDecisions(filter).catch(() => {});
    }, 10000);
    return () => clearInterval(pollRef.current);
  }, [filter]);

  // SSE: listen for root agent inbox tasks + completion events.
  useEffect(() => {
    const es = new EventSource('/api/agents/events');
    es.addEventListener('activity', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'root_inbox' && data.tasks) {
          setRootInbox((prev) => {
            const map = new Map(prev.map((t) => [t.task_id, t]));
            for (const t of data.tasks) {
              if (!rootProcessedRef.current.has(t.task_id)) map.set(t.task_id, t);
            }
            return [...map.values()].sort((a, b) =>
              (b.created_at || '').localeCompare(a.created_at || ''));
          });
        } else if (data.type === 'root_task_completed') {
          setRootInbox((prev) => prev.filter((t) => t.task_id !== data.task_id));
          rootProcessedRef.current.add(data.task_id);
        }
      } catch {}
    });
    return () => es.close();
  }, []);

  const onRootRespond = async (task, result) => {
    setBusy(true);
    try {
      await respondRootTask(task.task_id, result);
      setRootInbox((prev) => prev.filter((t) => t.task_id !== task.task_id));
      rootProcessedRef.current.add(task.task_id);
      setToast(`已回复: ${task.sender_name || 'Agent'}`);
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = () => {
    const ids = new Set(readIds);
    for (const d of list) {
      if (d.status === 'open') ids.add(d.decision_id);
    }
    setReadIds(ids);
    saveReadIds(ids);
    setToast(T.decisionsPage.allMarkedRead || '全部已阅');
  };

  const isRead = (id) => readIds.has(id);
  const openCount = list.filter((d) => d.status === 'open').length;
  const unreadOpen = list.filter((d) => d.status === 'open' && !readIds.has(d.decision_id)).length;

  const onApprove = async (d) => {
    setBusy(true);
    try {
      await approveDecision(d.decision_id);
      setToast(T.decisionsPage.approvedToast(d.title || d.decision_id));
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onReject = async (d) => {
    const comment = await boosPrompt(
      T.decisionsPage.rejectWithComment,
      '',
      { title: `${T.decisionsPage.reject}: ${d.title || d.decision_id}`, okLabel: T.decisionsPage.reject },
    );
    if (comment === null) return; // cancelled
    setBusy(true);
    try {
      await rejectDecision(d.decision_id, comment.trim() || undefined);
      setToast(T.decisionsPage.rejectedToast(d.title || d.decision_id));
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onReply = async (d, text) => {
    if (!text || !text.trim()) return;
    setBusy(true);
    try {
      await replyDecision(d.decision_id, text.trim());
      setToast(`已回复: ${d.title || d.decision_id}`);
      await fetchDecisions(filter);
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${PageTitleBar} title=${T.decisions.title} />
    <div class="decisions-page">
      <div class="decisions-filter">
        ${FILTER_TABS.map((t) => html`
          <button key=${t.key}
                  class=${`decision-filter-tab${filter === t.key ? ' is-active' : ''}`}
                  onClick=${() => setFilter(t.key)}
                  disabled=${busy}>
            ${t.label}
          </button>
        `)}
        ${filter === 'open' && unreadOpen > 0 ? html`
          <button class="action small subtle"
                  style="margin-left:auto;"
                  onClick=${markAllRead}
                  disabled=${busy}>
            全部已阅 (${unreadOpen})
          </button>
        ` : null}
      </div>
      <div class="decisions-list">
        ${rootInbox.length > 0 ? html`
          <div class="root-inbox-section">
            <div class="root-inbox-heading">📨 收件箱 · ${rootInbox.length} 条新消息</div>
            ${rootInbox.map((task) => html`
              <${RootTaskCard} key=${task.task_id} task=${task}
                onRespond=${onRootRespond} busy=${busy} />
            `)}
          </div>
        ` : null}
        ${merged.length === 0 && rootInbox.length === 0 ? html`
          <div class="decisions-empty">
            <p class="decisions-empty-title">${T.decisionsPage.noDecisions}</p>
            <p class="decisions-empty-hint">${T.decisionsPage.noDecisionsHint}</p>
          </div>
        ` : merged.map((entry) => {
          if (entry.type === 'group' && entry.count > 1) {
            return html`<${DecisionGroup} key=${entry.agent + '-' + entry.firstTs}
              group=${entry} isRead=${isRead}
              onApprove=${onApprove} onReject=${onReject} onReply=${onReply} busy=${busy} />`;
          }
          const d = entry.type === 'group' ? entry.items[0] : entry;
          return html`<${DecisionCard} key=${d.decision_id} d=${d}
            isRead=${isRead(d.decision_id)}
            onApprove=${onApprove} onReject=${onReject} onReply=${onReply} busy=${busy} />`;
        })}
      </div>
    </div>`;
}
