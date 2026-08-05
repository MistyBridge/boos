// Workspace terminal area — wraps TerminalView for the lower pane of WorkspacePage.
// Mirrors the wrapper structure from SessionsPage: session-pane-body > terminal-stack > terminal-layer.
// Shows the terminal for the currently selected agent, or an empty-state prompt.

import { html } from '../html.js';
import { useEffect } from 'preact/hooks';
import { TerminalView } from './TerminalView.js';
import { sessions, config } from '../state.js';
import { resumeSession } from '../api.js';
import { T } from '../i18n.js';

/**
 * @param {{ agent: { id:string, title:string, status:string, cliId:string }|null, onRefresh: () => void }} props
 */
export function WorkspaceTerminal({ agent, onRefresh }) {
  // ── no agent selected ───────────────────────────────────────────

  if (!agent) {
    return html`
      <div class="session-pane-body">
        <div class="terminal-empty">
          <div class="terminal-empty-icon">◈</div>
          <div>双击画布上的 agent 节点开始对话</div>
        </div>
      </div>`;
  }

  // ── find session + CLI info ─────────────────────────────────────

  const session = sessions.value.find((s) => s.id === agent.id);
  const cli = session
    ? (config.value?.clis || []).find((c) => c.id === session.cliId)
    : null;
  const running = session && session.status === 'running';

  // ── auto-resume for exited sessions ─────────────────────────────

  useEffect(() => {
    if (!session || session.manualStopped || running) return;
    resumeSession(session.id).catch(() => {});
  }, [session?.id]);

  // ── exited / stopped state ──────────────────────────────────────

  if (!running) {
    const isManualStop = session && session.manualStopped;
    return html`
      <div class="session-pane-body">
        <div class="terminal-empty">
          ${isManualStop ? html`
            <div>${T.sessionsPage.sessionStoppedTitle || '会话已停止'}</div>
            <button class="action primary" onClick=${() => {
              resumeSession(agent.id).then(() => onRefresh()).catch(() => {});
            }}>恢复会话</button>
          ` : html`
            <div>${T.sessionsPage.resumingSessionDots || '正在恢复会话…'}</div>
          `}
        </div>
      </div>`;
  }

  // ── running terminal ────────────────────────────────────────────

  return html`
    <div class="session-pane-body">
      <div class="terminal-stack">
        <div class="terminal-layer is-active" data-active="true" aria-hidden="false">
          <${TerminalView}
            key=${agent.id}
            terminalId=${agent.id}
            cliType=${cli?.type}
            visible=${true}
          />
        </div>
      </div>
    </div>`;
}
