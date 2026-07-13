// DecisionsPage — review and approve/reject decisions proposed by AI agents.
// Card list with filter tabs (Open / Decided / All), expand to read full
// Markdown content, approve (green) / reject (red) action buttons.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { decisions, config } from '../state.js';
import { fetchDecisions, getDecisionContent, approveDecision, rejectDecision } from '../api.js';
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

function DecisionCard({ d, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

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
    <div class=${`decision-card${expanded ? ' is-expanded' : ''}${isUrgent ? ' is-urgent' : ''}`}>
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

export function DecisionsPage() {
  clockTick.value; // subscribe for fmtAgo refresh
  const [filter, setFilter] = useState('open');
  const [busy, setBusy] = useState(false);
  const list = decisions.value;

  useEffect(() => {
    fetchDecisions(filter).catch(() => {});
  }, [filter]);

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
      </div>
      <div class="decisions-list">
        ${list.length === 0 ? html`
          <div class="decisions-empty">
            <p class="decisions-empty-title">${T.decisionsPage.noDecisions}</p>
            <p class="decisions-empty-hint">${T.decisionsPage.noDecisionsHint}</p>
          </div>
        ` : list.map((d) => html`
          <${DecisionCard} key=${d.decision_id} d=${d}
                           onApprove=${onApprove}
                           onReject=${onReject} />
        `)}
      </div>
    </div>`;
}
