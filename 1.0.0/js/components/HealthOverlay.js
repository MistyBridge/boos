// Full-screen modal shown while the backend is unreachable.
//
// Two phases:
//   - Early (failureCount < THRESHOLD): "Checking backend health…" with
//     a spinner. Most outages resolve in one or two ticks — no need to
//     scare the user.
//   - Persistent (failureCount >= THRESHOLD): "Backend not running.
//     Start backend" with a button that fires the boos:// protocol so
//     Windows' registered launcher.vbs spawns boos.
//
// We never auto-resume. The user has to click the button — protects
// against repeated wake attempts during an in-flight upgrade or a
// crash loop.
//
// While offline we drive a faster (1.5s) poll loop directly so the
// modal dismisses promptly when the backend comes back, without
// waiting for the main 5s refresh interval.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { serverHealth, hasBootedOnline } from '../state.js';
import { pollHealth, refreshAll } from '../api.js';
import { BrandMark } from '../icons.js';
import { isRemoteAccess } from '../backend.js';
import { T } from '../i18n.js';

const THRESHOLD = 3;     // failures before we switch from "checking" to "not running"
const FAST_POLL_MS = 1500;

export function HealthOverlay() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const count = h.failureCount || 0;
  const everSeen = hasBootedOnline.value;

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => { pollHealth(); }, FAST_POLL_MS);
    return () => clearInterval(id);
  }, [offline]);

  useEffect(() => {
    if (!offline && everSeen) {
      refreshAll().catch(() => {});
    }
  }, [offline]);

  if (!offline || !everSeen) return null;

  const showStart = count >= THRESHOLD;

  // Reuses the .offline-overlay / .offline-card classes so the card
  // layout (brand mark, big title, copy, primary action button,
  // collapsible npm-install fallback) matches what the OfflineBanner
  // used to render. HealthOverlay differs only in the two states:
  // early polls show a spinner + "Checking…" instead of the static
  // "Backend not running" card.
  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="offline-card">
        <div class="offline-brand">${
          showStart
            ? html`<${BrandMark} />`
            : html`<div class="health-spinner" aria-hidden="true"></div>`
        }</div>
        ${!showStart ? html`
          <h1 class="offline-title">${T.health.checking}</h1>
          <p class="offline-copy">
            ${count === 0 ? T.health.probing(7777) : T.health.attempts(count)}
          </p>
        ` : isRemoteAccess() ? html`
          <h1 class="offline-title">${T.health.hostOffline}</h1>
          <p class="offline-copy">${T.health.hostOfflineMsg}</p>
          <p class="offline-copy" style="margin-top:8px;font-size:12px;color:var(--ink-muted)">${T.health.keepPolling}</p>
        ` : html`
          <h1 class="offline-title">${T.health.backendDown}</h1>
          <p class="offline-copy">${T.health.backendDownMsg}</p>
          <div class="offline-actions">
            <a class="action primary big" href="boos://start">${T.health.startBackend}</a>
          </div>
          <details class="offline-fallback">
            <summary>${T.health.notInstalled}</summary>
            <div class="offline-fallback-body">
              <p>${T.health.installOnce}</p>
              <pre><code>npm i -g @MistyBridge/boos</code></pre>
              <p>${T.health.oneShot}</p>
              <pre><code>npx @MistyBridge/boos</code></pre>
            </div>
          </details>
        `}
      </div>
    </div>`;
}
