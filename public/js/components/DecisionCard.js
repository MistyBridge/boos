// Sprint 24 P6: DecisionCard — compact decision action card.
// Uses existing .decision-card, .decision-badge, and .action CSS classes.
// Supports batch mode checkbox selection.

import { html } from '../html.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';
import { T } from '../i18n.js';

export function DecisionCard({ decision, onApprove, onReject, onDefer, busy, checked, onToggleCheck, showCheckbox }) {
  clockTick.value;
  const { decision_id, title, agent_name, urgent, status, created_at } = decision;
  const isOpen = status === 'open';
  const ts = created_at ? new Date(created_at).getTime() : 0;

  function statusBadge(s) {
    if (s === 'approved') return html`<span class="decision-badge approved">${T.decisionsPage.approved}</span>`;
    if (s === 'deferred') return html`<span class="decision-badge deferred">${T.decisionsPage.deferred}</span>`;
    if (s === 'rejected') return html`<span class="decision-badge rejected">${T.decisionsPage.rejected}</span>`;
    return null;
  }

  return html`
    <div class=${`decision-card${urgent ? ' is-urgent' : ''}${checked ? ' is-selected' : ''}`}>
      <div class="decision-card-head">
        ${showCheckbox ? html`
          <label class="decision-card-check" onClick=${(e) => e.stopPropagation()}>
            <input type="checkbox" checked=${checked} onChange=${onToggleCheck} />
          </label>
        ` : null}
        <div class="decision-card-info" style="flex:1;min-width:0;">
          <div class="decision-card-title-row">
            <span class="decision-card-title">${title || decision_id}</span>
            ${urgent ? html`<span class="decision-badge urgent">${T.decisionsPage.urgent}</span>` : null}
            ${!isOpen ? statusBadge(status) : null}
          </div>
          <div class="decision-card-meta">
            <span>${T.decisionsPage.byAgent(agent_name || 'unknown')}</span>
            ${ts > 0 ? html`<span> · ${fmtAgo(ts)}</span>` : null}
          </div>
        </div>
        ${isOpen ? html`
          <div class="decision-card-actions">
            <button class="action small decision-approve"
                    onClick=${(e) => { e.stopPropagation(); onApprove(decision); }}
                    disabled=${busy}>${T.decisionsPage.approve}</button>
            <button class="action small decision-reject"
                    onClick=${(e) => { e.stopPropagation(); onReject(decision); }}
                    disabled=${busy}>${T.decisionsPage.reject}</button>
            <button class="action small subtle"
                    onClick=${(e) => { e.stopPropagation(); onDefer(decision); }}
                    disabled=${busy}>${T.decisionsPage.defer}</button>
          </div>
        ` : null}
      </div>
    </div>`;
}
