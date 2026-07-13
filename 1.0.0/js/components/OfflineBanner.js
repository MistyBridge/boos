// Fullscreen overlay shown when the backend is offline. Blocks
// interaction with the rest of the UI until backend comes back.
//
// The hosted frontend (https://MistyBridge.github.io/boos/v1/) can't
// spawn processes directly, so we surface a boos://start link instead.
// Windows hands that off to the registered protocol handler
// (boos.cmd), which spawns the backend silently. Our health probe
// picks it up on the next tick and the overlay auto-hides.
//
// First click triggers a Windows confirmation dialog ("Open boos.cmd?").
// User can check "Always allow" to suppress future prompts.

import { html } from '../html.js';
import { useEffect, useState, useRef } from 'preact/hooks';
import { serverHealth } from '../state.js';
import { refreshAll } from '../api.js';
import { httpBase } from '../backend.js';
import { BrandMark } from '../icons.js';
import { T } from '../i18n.js';

/** Format remaining milliseconds as a human-readable countdown. */
function fmtCountdown(ms) {
  if (ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min} min ${sec} sec`;
  return `${sec} sec`;
}

export function OfflineBanner() {
  const h = serverHealth.value;
  const offline = h.state === 'offline';
  const [clicked, setClicked] = useState(false);
  const [keepAlive, setKeepAlive] = useState(null);
  const pollRef = useRef(null);

  // We used to silently fire boos://start via a hidden iframe the
  // moment the backend went offline. Even when the user had OK'd
  // "Always allow" once, some browsers still flashed a momentary
  // confirmation prompt — and first-time visitors got a "Open
  // boos.cmd?" dialog with no apparent trigger, which is a bad UX.
  // The Start button below is the only path that fires the protocol
  // now; the health poll picks the backend up automatically once
  // the user clicks it (or starts boos from a terminal / shortcut).

  useEffect(() => {
    if (h.state === 'online' && clicked) {
      refreshAll().catch(() => {});
      setClicked(false);
    }
  }, [h.state, clicked]);

  // Poll /api/keep-alive/status every 60s to detect idle auto-stop.
  // Only polls when the server is online — no point hitting an offline
  // backend. Clear the status when server goes offline so the idle
  // banner doesn't linger during a disconnect.
  useEffect(() => {
    if (h.state !== 'online') {
      setKeepAlive(null);
      return;
    }

    const poll = async () => {
      try {
        const r = await fetch(httpBase() + '/api/keep-alive/status');
        if (!r.ok) return;
        const data = await r.json();
        setKeepAlive(data);
      } catch { /* backend unreachable — health poll will surface it */ }
    };

    poll(); // immediate first fetch
    pollRef.value = setInterval(poll, 60_000);
    return () => { if (pollRef.value) clearInterval(pollRef.value); };
  }, [h.state]);

  // ── idle warning banner (non-blocking) ──────────────────────────
  // Server is online but has been idle long enough that auto-stop is
  // counting down. Show a slim banner — NOT the full offline overlay.
  const idle = keepAlive && keepAlive.idleTimeMs > 0;
  if (idle && !offline) {
    const remaining = keepAlive.willShutdownAfterMs;
    const label = remaining > 0 ? `Server idle · auto-stop in ${fmtCountdown(remaining)}` : 'Server idle · stopping soon';
    return html`
      <div class="idle-warning-banner" role="status" aria-live="polite">
        <span class="idle-warning-text">${label}</span>
      </div>`;
  }

  if (!offline) return null;

  // ── full offline overlay ────────────────────────────────────────
  return html`
    <div class="offline-overlay" role="dialog" aria-modal="true" aria-labelledby="offline-title">
      <div class="offline-card">
        <div class="offline-brand"><${BrandMark} /></div>
        <h1 id="offline-title" class="offline-title">${T.health.backendDown}</h1>
        <p class="offline-copy">
          ${T.health.backendDownMsg}
        </p>
        <div class="offline-actions">
          <a class="action primary big" href="boos://start"
             onClick=${() => setClicked(true)}>${T.health.startCcsm}</a>
        </div>
        <details class="offline-fallback">
          <summary>${T.health.notInstalledCcsm}</summary>
          <div class="offline-fallback-body">
            <p>${T.health.installOnce}</p>
            <pre><code>npm i -g @MistyBridge/boos</code></pre>
            <p>${T.health.oneShot}</p>
            <pre><code>npx @MistyBridge/boos</code></pre>
          </div>
        </details>
      </div>
    </div>`;
}
