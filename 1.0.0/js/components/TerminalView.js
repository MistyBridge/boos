// TerminalView is the Preact shell around a VS Code-style terminal instance:
// TerminalView -> TerminalInstance -> XtermTerminal -> raw xterm.js.

import { html } from '../html.js';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { themeMode } from '../state.js';
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

export function TerminalView({ terminalId, cliType, visible = true }) {
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

  useEffect(() => {
    const host = hostRef.current;
    if (!terminalId || !host) return;

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
    });
    instanceRef.current = instance;
    instance.attachToElement(host);
    instance.setVisible(visible);
    if (visible) instance.focus();

    return () => {
      if (instanceRef.current === instance) instanceRef.current = null;
      instance.dispose();
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
  return html`
    <${Fragment}>
      <div key="host" ref=${hostRef} class="terminal-host" style=${{ position: 'relative' }}></div>
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
    </${Fragment}>`;
}
