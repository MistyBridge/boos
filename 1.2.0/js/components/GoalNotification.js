// Sprint 37: GoalNotification — bottom-right toast for goal/DAG events via SSE.
// Auto-dismisses after 5s or on manual close. BOOS calm aesthetic.

import { html } from '../html.js';
import { signal } from '@preact/signals';

// Inline SVG close icon — avoids emoji/special characters.
const closeIcon = html`
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>`;

// Shared signal for notifications — other modules can push to this.
export const goalNotifications = signal([]);

let _nextId = 0;
const MAX_NOTIFICATIONS = 5;

export function pushGoalNotification({ title, message, type }) {
  const id = ++_nextId;
  const item = { id, title, message, type: type || 'info', at: Date.now() };
  const current = goalNotifications.value;
  const next = [item, ...current].slice(0, MAX_NOTIFICATIONS);
  goalNotifications.value = next;
  setTimeout(() => {
    goalNotifications.value = goalNotifications.value.filter((n) => n.id !== id);
  }, 5000);
}

const TYPE_STYLES = {
  info:    { border: 'var(--blue)', bg: 'var(--bg-elev)' },
  success: { border: 'var(--green)', bg: 'var(--bg-elev)' },
  warning: { border: '#cc9a06', bg: 'var(--bg-elev)' },
  error:   { border: 'var(--red)', bg: 'var(--bg-elev)' },
};

export function GoalNotification() {
  const list = goalNotifications.value || [];
  if (list.length === 0) return null;

  return html`
    <div style="position:fixed;bottom:var(--s-3);right:var(--s-3);z-index:9999;display:flex;flex-direction:column-reverse;gap:var(--s-2);max-width:360px;">
      ${list.map((n) => {
        const s = TYPE_STYLES[n.type] || TYPE_STYLES.info;
        return html`
          <div key=${n.id}
               style="background:${s.bg};border-left:3px solid ${s.border};border-radius:6px;
                      box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:var(--s-2) var(--s-3);
                      font-size:13px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--s-2);">
              <div>
                ${n.title ? html`<div style="font-weight:600;color:var(--ink);margin-bottom:2px;">${n.title}</div>` : null}
                <div style="color:var(--ink-mid);line-height:1.4;">${n.message}</div>
              </div>
              <button style="background:none;border:none;cursor:pointer;color:var(--ink-muted);font-size:14px;padding:0;line-height:1;"
                      onClick=${() => { goalNotifications.value = goalNotifications.value.filter((x) => x.id !== n.id); }}>
                ${closeIcon}
              </button>
            </div>
          </div>`;
      })}
    </div>
  `;
}
