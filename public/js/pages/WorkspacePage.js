// Workspace page — split view with agent node canvas (upper) + terminal (lower).
// Replaces the default SessionsPage when a workspace context is active.
// Agents are BOOS sessions sharing the same workspace directory.
//
// Layout persistence: agent positions + split ratio stored in workspace/.boos/layout.json
// Activity colours: updated in real time via WebSocket agent_status messages.

import { html } from '../html.js';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import {
  sessions, config, activeSessionId, selectSession, selectWorkspaceAgent,
  workspaceAgentActivity, workspaceFolderId, sessionsByFolder, folders,
} from '../state.js';
import { fetchAgents, subscribeAgentEvents, sendAgentCommand } from '../api.js';
import { setToast } from '../toast.js';
// Layout persisted in localStorage (keyed by workspace name) —
// avoids dependency on physical workspace directories.
const LS_LAYOUT_PREFIX = 'boos.workspace-layout.';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { AgentCanvas } from '../components/AgentCanvas.js';
import { WorkspaceTerminal } from '../components/WorkspaceTerminal.js';

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;

/**
 * Group sessions whose cwds share the same parent directory (≥2 siblings).
 * Returns { prefix: 'D:/project/claudes', name: 'claudes' } for the
 * currently active session's group, or null if no sibling group exists.
 */
function _findSiblingGroup(sessions, activeSid) {
  const parentMap = new Map();
  for (const s of sessions) {
    if (s.deletedAt || !s.cwd) continue;
    const cwd = s.cwd.replace(/\\/g, '/');
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const parent = parts.slice(0, -1).join('/');
    if (!parentMap.has(parent)) parentMap.set(parent, []);
    parentMap.get(parent).push(s.id);
  }
  // Find the group containing the active session (or any group if none active).
  for (const [parent, ids] of parentMap) {
    if (ids.length < 2) continue;
    const name = parent.split('/').pop() || parent;
    if (activeSid && ids.includes(activeSid)) return { prefix: '/' + parent, name };
  }
  // Fallback: first group with ≥2 siblings.
  for (const [parent, ids] of parentMap) {
    if (ids.length < 2) continue;
    const name = parent.split('/').pop() || parent;
    return { prefix: '/' + parent, name };
  }
  return null;
}

/**
 * Get a session's workspace key: either the sibling group it belongs to,
 * or its own BOOS workspace / cwd basename.
 */
function _sessionKey(s, group) {
  if (!s) return '';
  if (group && s.cwd) {
    const cwd = s.cwd.replace(/\\/g, '/');
    if (cwd.startsWith(group.prefix)) return group.name;
  }
  return s.workspace || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function WorkspacePage() {
  // Subscribe to signals at render level (Preact pattern).
  const sid = activeSessionId.value;
  const allSessions = sessions.value;
  const clis = (config.value?.clis || []);
  const activityMap = workspaceAgentActivity.value;

  // ── determine grouping: folder (explicit) or sibling cwd (auto) ──
  const fid = workspaceFolderId.value;
  const grouped = sessionsByFolder.value;
  const folderList = folders.value;
  let group = null;
  let activeKey = '';
  let agentSessions = [];

  if (fid) {
    // Folder-based grouping — the user explicitly opened a folder's canvas.
    const inFolder = grouped.get(fid) || [];
    agentSessions = inFolder.filter((s) => !s.deletedAt);
    const f = folderList.find((x) => x.id === fid);
    activeKey = f ? f.name : (fid === 'unsorted' ? '未分类' : fid);
  } else {
    // Auto-detect sibling group (sessions sharing the same parent directory).
    group = _findSiblingGroup(allSessions, sid);
    const activeSession = sid ? allSessions.find((s) => s.id === sid) : null;
    activeKey = _sessionKey(activeSession, group);

    if (group) {
      // Filter to sessions in the detected sibling group.
      agentSessions = allSessions.filter(
        (s) => !s.deletedAt && _sessionKey(s, group) === group.name,
      );
    } else if (activeKey) {
      // No sibling group, but the active session has a workspace key.
      agentSessions = allSessions.filter(
        (s) => !s.deletedAt && _sessionKey(s, null) === activeKey,
      );
    } else {
      // Fallback: no active session and no sibling group detected.
      // Show all non-deleted sessions rather than an empty canvas.
      agentSessions = allSessions.filter((s) => !s.deletedAt);
    }
  }

  // ── local state ──────────────────────────────────────────────────
  const [layout, setLayout] = useState({ agentPositions: {}, splitRatio: 0.5 });
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingCounts, setPendingCounts] = useState({});
  const pageRef = useRef(null);

  // ── BNTP command bar state ─────────────────────────────────────────
  const [bntpCommand, setBntpCommand] = useState('');
  const [showBntpHelp, setShowBntpHelp] = useState(false);
  const [bntpSubmitting, setBntpSubmitting] = useState(false);
  const bntpInputRef = useRef(null);

  // Autocomplete: detect @task <partial> and suggest agent names.
  const _bntpSuggestions = (() => {
    const m = bntpCommand.match(/^@task\s+(\S*)$/);
    if (!m) return [];
    const partial = m[1].toLowerCase();
    if (!partial) return agentList.slice(0, 6).map((a) => a.title);
    return agentList
      .filter((a) => a.title.toLowerCase().startsWith(partial))
      .slice(0, 6)
      .map((a) => a.title);
  })();

  // ── agent-bus → canvas bridge ─────────────────────────────────────

  // Bootstrap: fetch merged agent state on mount, seed activity + pending maps.
  useEffect(() => {
    fetchAgents().then((r) => {
      const act = { ...workspaceAgentActivity.value };
      const pnd = {};
      for (const a of r.agents || []) {
        if (a.sessionId) {
          act[a.sessionId] = a.agentBusActivity === 'busy' ? 'working' : 'idle';
          pnd[a.sessionId] = a.pendingTasks || 0;
        }
      }
      workspaceAgentActivity.value = act;
      setPendingCounts(pnd);
    }).catch(() => {});
  }, []);

  // SSE: subscribe to real-time agent activity + task count changes.
  useEffect(() => {
    const unsub = subscribeAgentEvents((data) => {
      if (data.type === 'snapshot') {
        const pnd = {};
        for (const a of data.agents || []) {
          if (a.sessionId) pnd[a.sessionId] = a.pendingTasks || 0;
        }
        setPendingCounts(pnd);
        return;
      }
      if (data.type === 'registry') return;
      // activity event: update status + pending count.
      if (data.sessionId) {
        const isBusy = data.activity === 'busy' || data.activity === 'woken';
        workspaceAgentActivity.value = {
          ...workspaceAgentActivity.value,
          [data.sessionId]: isBusy ? 'working' : 'idle',
        };
        setPendingCounts((prev) => ({ ...prev, [data.sessionId]: data.pending || 0 }));
      }
    });
    return unsub;
  }, []);

  // ── build agent list ─────────────────────────────────────────────
  const agentList = agentSessions.map((s) => ({
    id: s.id,
    title: s.title || s.id.slice(0, 12),
    activity: activityMap[s.id] || s.activity || 'unknown',
    status: s.status,
    cliId: s.cliId,
    cliType: clis.find((c) => c.id === s.cliId)?.type,
    pendingTasks: pendingCounts[s.id] || 0,
  }));

  const selectedAgent = agentList.find((a) => a.id === sid) || null;
  // Derive a meaningful workspace name even in fallback mode —
  // '工作区' is a generic catch-all, but when we show all sessions we
  // can label it with the count so the user knows what they're looking at.
  const wsName = group ? group.name
    : activeKey
      || (agentSessions.length > 0 ? `全部会话 (${agentSessions.length})` : '工作区');

  // ── load layout from localStorage ────────────────────────────────

  useEffect(() => {
    if (!wsName) return;
    try {
      const raw = localStorage.getItem(LS_LAYOUT_PREFIX + wsName);
      if (raw) {
        const data = JSON.parse(raw);
        setLayout({
          agentPositions: data.agentPositions || {},
          splitRatio: typeof data.splitRatio === 'number' ? data.splitRatio : 0.5,
        });
      }
    } catch {}
  }, [wsName, refreshKey]);

  // ── save layout (debounced in AgentCanvas) ──────────────────────

  const _handleSaveLayout = useCallback((data) => {
    if (!wsName) return;
    try {
      localStorage.setItem(LS_LAYOUT_PREFIX + wsName, JSON.stringify({
        agentPositions: data.agentPositions || {},
        splitRatio: layout.splitRatio,
      }));
    } catch {}
  }, [wsName, layout.splitRatio]);

  // ── split handle drag ───────────────────────────────────────────

  const _onSplitDragStart = useCallback((e) => {
    e.preventDefault();
    setIsDraggingSplit(true);
  }, []);

  useEffect(() => {
    if (!isDraggingSplit) return;

    const _onMove = (e) => {
      if (!pageRef.current) return;
      const rect = pageRef.current.getBoundingClientRect();
      const ratio = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT,
        (e.clientY - rect.top) / rect.height));
      setLayout((prev) => ({ ...prev, splitRatio: ratio }));
    };

    const _onUp = () => {
      setIsDraggingSplit(false);
      if (wsName) {
        try {
          localStorage.setItem(LS_LAYOUT_PREFIX + wsName, JSON.stringify({
            agentPositions: layout.agentPositions,
            splitRatio: layout.splitRatio,
          }));
        } catch {}
      }
    };

    window.addEventListener('pointermove', _onMove);
    window.addEventListener('pointerup', _onUp);
    return () => {
      window.removeEventListener('pointermove', _onMove);
      window.removeEventListener('pointerup', _onUp);
    };
  }, [isDraggingSplit]); // layout and wsName read from closure — stable enough

  // ── agent selection ─────────────────────────────────────────────

  const _handleSelectAgent = useCallback((uid) => {
    selectWorkspaceAgent(uid);
  }, []);

  // ── BNTP handlers ──────────────────────────────────────────────────

  const _handleBntpSend = useCallback(async () => {
    const cmd = bntpCommand.trim();
    if (!cmd) return;

    if (cmd === '@help') {
      setShowBntpHelp(true);
      setBntpCommand('');
      return;
    }

    setBntpSubmitting(true);
    try {
      await sendAgentCommand(cmd, sid);
      setToast('命令已发送');
      setBntpCommand('');
    } catch (e) {
      setToast(e.message || '命令发送失败', 'error');
    } finally {
      setBntpSubmitting(false);
    }
  }, [bntpCommand, sid]);

  const _handleBntpKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _handleBntpSend();
    }
  }, [_handleBntpSend]);

  const _fillSuggestion = useCallback((name) => {
    setBntpCommand(`@task ${name} `);
    if (bntpInputRef.current) bntpInputRef.current.focus();
  }, []);

  // ── render ──────────────────────────────────────────────────────

  const splitPct = Math.round(layout.splitRatio * 100);

  return html`
    <${PageTitleBar} title=${html`
      <span class="session-title-text">${wsName || '工作区'}</span>
      <span class="session-title-cwd">${agentList.length} 个 agent</span>
    `} />
    <div class="workspace-page" ref=${pageRef}
         style=${{ '--split-ratio': layout.splitRatio }}>
      <div class="workspace-canvas-pane" style=${{ flex: `${splitPct} 0 0` }}>
        <div class="workspace-bntp-bar">
          <div class="bntp-input-wrap">
            <input
              ref=${bntpInputRef}
              class="bntp-input"
              type="text"
              placeholder="@task <agent> <内容>  |  @done <id> <结果>  |  @tasks  |  @agents  |  @help"
              value=${bntpCommand}
              onInput=${(ev) => setBntpCommand(ev.target.value)}
              onKeyDown=${_handleBntpKeyDown}
            />
            ${_bntpSuggestions.length > 0 && html`
              <div class="bntp-suggestions">
                ${_bntpSuggestions.map((name) => html`
                  <div class="bntp-suggestion-item" onClick=${() => _fillSuggestion(name)}>${name}</div>
                `)}
              </div>
            `}
          </div>
          <button class="action small primary"
                  onClick=${_handleBntpSend}
                  disabled=${bntpSubmitting || !bntpCommand.trim()}>发送</button>
          <button class="action small subtle bntp-help-btn"
                  onClick=${() => setShowBntpHelp(!showBntpHelp)}
                  title="BNTP 帮助">?</button>
        </div>
        ${showBntpHelp && html`
          <div class="workspace-bntp-help">
            <h4>BNTP 命令格式</h4>
            <table class="bntp-help-table">
              <tr><td>@task &lt;agent&gt; &lt;内容&gt;</td><td>向指定 agent 发送任务</td></tr>
              <tr><td>@done &lt;id&gt; &lt;结果&gt;</td><td>标记任务完成并回复结果</td></tr>
              <tr><td>@tasks</td><td>查看自己的待办任务列表</td></tr>
              <tr><td>@agents</td><td>列出所有在线 agent</td></tr>
              <tr><td>@help</td><td>显示此帮助面板</td></tr>
            </table>
            <div class="bntp-help-hint">Enter 发送 · Shift+Enter 换行 · 输入 @task 空格自动补全 agent 名称</div>
          </div>
        `}
        <div class="workspace-canvas-wrap">
          <${AgentCanvas}
            agents=${agentList}
            positions=${layout.agentPositions}
            activeAgentId=${sid}
            onSelectAgent=${_handleSelectAgent}
            onSaveLayout=${_handleSaveLayout}
          />
        </div>
      </div>
      <div class="workspace-split-handle"
           onPointerDown=${_onSplitDragStart}>
        <div class="workspace-split-grip"></div>
      </div>
      <div class="workspace-terminal-pane" style=${{ flex: `${100 - splitPct} 0 0` }}>
        <${WorkspaceTerminal}
          agent=${selectedAgent}
          onRefresh=${() => setRefreshKey((k) => k + 1)}
        />
      </div>
    </div>`;
}
