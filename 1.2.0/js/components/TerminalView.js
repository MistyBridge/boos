// TerminalView is the Preact shell around a VS Code-style terminal instance:
// TerminalView -> TerminalInstance -> XtermTerminal -> raw xterm.js.
//
// Sprint 18 P0:
//   Task 1 — Independent Canvas: terminal host div created via raw DOM
//     (document.createElement), never managed by Preact's vDOM. xterm.js
//     opens directly on the bare div ref. Preact only owns a layout wrapper.
//     Tab switching uses CSS visibility + GPU compositing, not mount/unmount.
//   Task 3 — Zero signal writes from terminal code: agent_status dispatched
//     through onAgentStatus callback; signal writes stay in Preact land.

import { html } from '../html.js';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { themeMode, workspaceAgentActivity, sessions } from '../state.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { TerminalKeyBar } from './TerminalKeyBar.js';
import { TerminalInstance } from './TerminalInstance.js';
import { T } from '../i18n.js';

/** Format a delay in ms to a human-readable string. */
function fmtReconnectDelay(ms) {
  if (ms <= 0) return '…';
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${min}m ${s}s` : `${min}m`;
}

/**
 * Default handler for agent_status frames from the terminal WebSocket.
 * Writes into Preact signals (workspaceAgentActivity + sessions) so the
 * workspace canvas and sidebar dots reflect live agent activity.
 * Kept in Preact-land (TerminalView) — TerminalInstance never touches signals.
 */
function handleAgentStatus(frame) {
  if (!frame || !frame.sessionId) return;
  // Update workspace canvas view signal.
  workspaceAgentActivity.value = {
    ...workspaceAgentActivity.value,
    [frame.sessionId]: frame.activity,
  };
  // Also update the session's activity field so Sidebar tree-dot shows
  // correct is-working animation.
  const list = sessions.value;
  const idx = list.findIndex((s) => s.id === frame.sessionId);
  if (idx >= 0 && list[idx].activity !== frame.activity) {
    const updated = [...list];
    updated[idx] = { ...updated[idx], activity: frame.activity };
    sessions.value = updated;
  }
}

export function TerminalView({ terminalId, cliType, visible = true }) {
  // ── Task 1: Terminal host is a raw DOM div, NOT in Preact's vDOM ──
  // anchorRef  → Preact-managed layout wrapper (positioning only)
  // hostRef    → raw document.createElement('div'), never seen by Preact
  const anchorRef = useRef(null);
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const [displaced, setDisplaced] = useState(false);
  const [reattachNonce, setReattach] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectDelay, setReconnectDelay] = useState(0);
  const mode = themeMode.value;

  const sendInput = (data) => {
    instanceRef.current?.sendInput(data);
  };

  const onManualReconnect = () => {
    instanceRef.current?.manualReconnect();
  };

  useEffect(() => {
    instanceRef.current?.applyTheme();
    const apply = () => instanceRef.current?.applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode, reattachNonce]);

  // ── Task 1: Create terminal host as raw DOM element ──
  // Preact owns the anchor wrapper (<div class="terminal-host-anchor">).
  // The actual .terminal-host div is created via document.createElement and
  // appended directly to the anchor. xterm.js opens on this bare div.
  // Preact NEVER re-renders this subtree — it's invisible to the vDOM.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !terminalId) return;

    // Create bare DOM div — lives entirely outside Preact's rendering tree.
    const host = document.createElement('div');
    host.className = 'terminal-host';
    host.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'contain:strict;will-change:transform';
    anchor.appendChild(host);
    hostRef.current = host;

    const instance = new TerminalInstance({
      terminalId,
      cliType,
      onDisplaced: () => setDisplaced(true),
      onReconnecting: (isReconnecting, attempt, delay) => {
        setReconnecting(isReconnecting);
        if (isReconnecting) {
          setReconnectAttempt(attempt);
          setReconnectDelay(delay);
        }
      },
      onReconnected: () => {
        setReconnecting(false);
        setReconnectAttempt(0);
        setReconnectDelay(0);
      },
      // ── Task 3: agent_status via callback, TerminalInstance never touches signals ──
      onAgentStatus: handleAgentStatus,
    });
    instanceRef.current = instance;
    instance.attachToElement(host);
    instance.setVisible(visible);
    if (visible) instance.focus();

    return () => {
      if (instanceRef.current === instance) instanceRef.current = null;
      instance.dispose();
      // Remove the raw DOM div we created — Preact doesn't know about it.
      host.remove();
      hostRef.current = null;
    };
  }, [terminalId, reattachNonce]);

  useEffect(() => {
    instanceRef.current?.setCliType(cliType);
  }, [cliType, terminalId, reattachNonce]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setVisible(visible);
    if (visible) {
      instance.focus();
    } else {
      instance.blur();
    }
  }, [visible, terminalId, reattachNonce]);

  if (!terminalId) {
    return html`<div class="terminal-empty">${T.terminal.empty}</div>`;
  }
  if (displaced) {
    return html`
      <section key="displaced" class="terminal-displaced">
        <div class="terminal-displaced-card">
          <h2>${T.terminal.displacedTitle}</h2>
          <p>
            ${T.terminal.displacedBody}
          </p>
          <div class="terminal-displaced-actions">
            <button class="action primary"
                    onClick=${() => {
                      setDisplaced(false);
                      setReattach((n) => n + 1);
                    }}>
              ${T.terminal.takeBack}
            </button>
          </div>
          <p class="terminal-displaced-hint">
            ${T.terminal.takeBackHint}
          </p>
        </div>
      </section>`;
  }

  // ── Task 1: Only the anchor wrapper is in JSX ──
  // The .terminal-host div is created and managed via raw DOM (see useEffect above).
  // Preact only re-renders this lightweight wrapper; the terminal canvas inside
  // is completely independent of vDOM reconciliation.
  return html`<${ErrorBoundary} name="TerminalView">
    <${Fragment}>
      <div key="host"
           ref=${anchorRef}
           class="terminal-host-anchor"
           style="position:relative;width:100%;height:100%;min-height:0;contain:strict">
        <!-- terminal-host div inserted here via raw DOM (not JSX) -->
      </div>
      ${reconnecting ? html`
        <div class="terminal-reconnect-overlay">
          <div class="terminal-reconnect-card">
            <div class="terminal-reconnect-spinner"></div>
            <p class="terminal-reconnect-text">${T.terminal.reconnecting}</p>
            <p class="terminal-reconnect-detail">
              ${T.terminal.reconnectAttempt(reconnectAttempt)} · ${T.terminal.reconnectIn(fmtReconnectDelay(reconnectDelay))}
            </p>
            <button class="action subtle terminal-reconnect-btn"
                    onClick=${onManualReconnect}>
              ${T.terminal.reconnectNow}
            </button>
          </div>
        </div>
      ` : null}
      ${visible ? html`<${TerminalKeyBar} send=${sendInput} cliType=${cliType} />` : null}
    </${Fragment}>
  </${ErrorBoundary}>`;
}
