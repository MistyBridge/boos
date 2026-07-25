// Sprint 24 P6: DecisionPage — decision dashboard with summary stats,
// decision list with approve/reject/defer, and batch operations.
// Uses DecisionCard component for individual decision items.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { decisions, decisionSummary, clockTick } from '../state.js';
import { fetchDecisions, fetchDecisionSummary, approveDecision, rejectDecision, deferDecision, batchDecisions } from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { Card } from '../components/Card.js';
import { DecisionCard } from '../components/DecisionCard.js';
import { T } from '../i18n.js';

// ── stat pill ────────────────────────────────────────────────────
function StatPill({ color, label, count }) {
  return html`
    <div class="row" style="gap:6px;font-size:13px;">
      <span class="status-mark" style=${{ background: color, boxShadow: 'none' }} />
      <span>${label}</span>
      <strong>${count}</strong>
    </div>`;
}

// ── Page ─────────────────────────────────────────────────────────
export function DecisionPage() {
  clockTick.value; // subscribe for fmtAgo refresh
  const [busy, setBusy]       = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [batchMode, setBatchMode]   = useState(false);

  const list       = Array.isArray(decisions.value) ? decisions.value : [];
  const summary    = decisionSummary.value || { open: 0, urgent: 0, deferred: 0 };
  const openList   = list.filter((d) => d.status === 'open');

  // Fetch on mount
  useEffect(() => {
    fetchDecisions('open').catch(() => {});
    fetchDecisionSummary().catch(() => {});
  }, []);

  // 10s auto-refresh
  useEffect(() => {
    const timer = setInterval(() => {
      fetchDecisions('open').catch(() => {});
      fetchDecisionSummary().catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // ── actions ────────────────────────────────────────────────────
  const onApprove = async (d) => {
    if (busy) return;
    setBusy(true);
    try {
      await approveDecision(d.decision_id);
      setToast(T.decisionsPage.approvedToast(d.title || d.decision_id));
    } catch (e) {
      setToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const onReject = async (d) => {
    if (busy) return;
    setBusy(true);
    try {
      await rejectDecision(d.decision_id, '');
      setToast(T.decisionsPage.rejectedToast(d.title || d.decision_id));
    } catch (e) {
      setToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const onDefer = async (d) => {
    if (busy) return;
    setBusy(true);
    try {
      await deferDecision(d.decision_id);
      setToast(T.decisionsPage.deferredToast(d.title || d.decision_id));
    } catch (e) {
      setToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  // ── batch ──────────────────────────────────────────────────────
  const toggleCheck = (id) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (checkedIds.size === openList.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(openList.map((d) => d.decision_id)));
    }
  };

  const onBatchAction = async (action) => {
    const ids = [...checkedIds];
    if (ids.length === 0) return;
    const label = action === 'approve' ? T.decisionsPage.batchApprove
      : action === 'reject' ? T.decisionsPage.batchReject
      : T.decisionsPage.batchDefer;
    const ok = await boosConfirm(
      T.decisionsPage.batchConfirm(label, ids.length),
      { title: label, okLabel: label },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await batchDecisions(action, ids);
      setCheckedIds(new Set());
      setBatchMode(false);
      setToast(T.decisionsPage.batchDone(label, ids.length));
    } catch (e) {
      setToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  return html`
    <${PageTitleBar} title=${T.decisions.title} />

    <div class="decisions-page">
      <!-- Summary stats -->
      <div class="row" style="gap:var(--s-4);margin-bottom:var(--s-2);flex-wrap:wrap;">
        <${StatPill} color="var(--blue)"  label=${T.decisionsPage.pending} count=${summary.open || 0} />
        <${StatPill} color="var(--red)"   label=${T.decisionsPage.urgent}  count=${summary.urgent || 0} />
        <${StatPill} color="var(--ink-muted)" label=${T.decisionsPage.deferred} count=${summary.deferred || 0} />
      </div>

      <!-- Toolbar: batch toggle + batch actions -->
      <div class="row" style="justify-content:space-between;margin-bottom:var(--s-2);">
        <label class="row" style="gap:6px;font-size:12.5px;color:var(--ink-mid);cursor:pointer;">
          <input type="checkbox" checked=${batchMode}
                 onChange=${() => { setBatchMode(!batchMode); setCheckedIds(new Set()); }} />
          ${T.decisionsPage.batchApprove}/${T.decisionsPage.batchReject}/${T.decisionsPage.batchDefer}
        </label>
        ${batchMode ? html`
          <div class="row" style="gap:var(--s-2);">
            <span style="font-size:11.5px;color:var(--ink-muted);">${T.decisionsPage.selected(checkedIds.size)}</span>
            <button class="action small primary" disabled=${checkedIds.size === 0 || busy}
                    onClick=${() => onBatchAction('approve')}>
              ${T.decisionsPage.batchApprove}
            </button>
            <button class="action small danger" disabled=${checkedIds.size === 0 || busy}
                    onClick=${() => onBatchAction('reject')}>
              ${T.decisionsPage.batchReject}
            </button>
            <button class="action small subtle" disabled=${checkedIds.size === 0 || busy}
                    onClick=${() => onBatchAction('defer')}>
              ${T.decisionsPage.batchDefer}
            </button>
          </div>
        ` : null}
      </div>

      <!-- Decision list -->
      <${Card} title="决策列表" flush=${true}>
        <div class="decisions-list" style="padding:0 var(--s-5) var(--s-5);">
          ${batchMode && openList.length > 0 ? html`
            <div class="row" style="gap:6px;padding:4px 0;font-size:12px;color:var(--ink-muted);cursor:pointer;"
                 onClick=${toggleAll}>
              <input type="checkbox" checked=${checkedIds.size === openList.length && openList.length > 0} />
              <span>全选 (${openList.length})</span>
            </div>
          ` : null}
          ${openList.length === 0 ? html`
            <div class="decisions-empty">
              <p class="decisions-empty-title">${T.decisionsPage.noDecisions}</p>
              <p class="decisions-empty-hint">${T.decisionsPage.noDecisionsHint}</p>
            </div>
          ` : openList.map((d) => html`
            <${DecisionCard} key=${d.decision_id}
              decision=${d}
              onApprove=${onApprove}
              onReject=${onReject}
              onDefer=${onDefer}
              busy=${busy}
              checked=${checkedIds.has(d.decision_id)}
              onToggleCheck=${() => toggleCheck(d.decision_id)}
              showCheckbox=${batchMode} />
          `)}
        </div>
      </${Card}>
    </div>`;
}
