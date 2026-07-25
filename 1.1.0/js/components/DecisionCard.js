// Sprint 24 P6: DecisionCard — reusable decision action card for DecisionPage.
// Shows title, agent name, urgency badge, timestamp, and approve/reject/defer buttons.
// Supports batch mode with checkboxes.

import { html } from '../html.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';
import { T } from '../i18n.js';

export function DecisionCard({ decision, onApprove, onReject, onDefer, busy, checked, onToggleCheck, showCheckbox }) {
  clockTick.value; // subscribe for fmtAgo refresh
  const isOpen = decision.status === 'open';
  const isUrgent = decision.urgent;
  const ts = decision.created_at ? new Date(decision.created_at).getTime() : 0;

  return html`
    <div class=${`decision-card${isUrgent ? ' is-urgent' : ''}${checked ? ' is-selected' : ''}`}>
      <div class="decision-card-head">
        ${showCheckbox ? html`
          <label class="decision-card-check" onClick=${(ev) => ev.stopPropagation()}>
            <input type="checkbox" checked=${checked} onChange=${onToggleCheck} />
          </label>
        ` : null}
        <div class="decision-card-info" style="flex:1;min-width:0;">
          <div class="decision-card-title-row">
            <span class="decision-card-title">${decision.title || '未命名决策'}</span>
            ${isUrgent ? html`<span class="decision-badge urgent">${T.decisionsPage.urgent}</span>` : null}
            ${!isOpen ? html`
              <span class=${`decision-badge ${decision.status === 'approved' ? 'approved' : decision.status === 'deferred' ? 'deferred' : 'rejected'}`}>
                ${decision.status === 'approved' ? T.decisionsPage.approved : decision.status === 'deferred' ? T.decisionsPage.deferred : T.decisionsPage.rejected}
              </span>
            ` : null}
          </div>
          <div class="decision-card-meta">
            <span>${T.decisionsPage.byAgent(decision.agent_name || 'unknown')}</span>
            ${ts > 0 ? html`<span> · ${fmtAgo(ts)}</span>` : null}
          </div>
        </div>
        ${isOpen ? html`
          <div class="decision-card-actions">
            <button class="action small primary"
                    onClick=${(ev) => { ev.stopPropagation(); onApprove(decision); }}
                    disabled=${busy}>
              ${T.decisionsPage.approve}
            </button>
            <button class="action small danger"
                    onClick=${(ev) => { ev.stopPropagation(); onReject(decision); }}
                    disabled=${busy}>
              ${T.decisionsPage.reject}
            </button>
            <button class="action small subtle"
                    onClick=${(ev) => { ev.stopPropagation(); onDefer(decision); }}
                    disabled=${busy}>
              ${T.decisionsPage.defer}
            </button>
          </div>
        ` : null}
      </div>
    </div>`;
}
