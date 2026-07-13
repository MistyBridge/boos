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
  const pageRef = useRef(null);

  // ── build agent list ─────────────────────────────────────────────
  const agentList = agentSessions.map((s) => ({
    id: s.id,
    title: s.title || s.id.slice(0, 12),
    activity: activityMap[s.id] || s.activity || 'unknown',
    status: s.status,
    cliId: s.cliId,
    cliType: clis.find((c) => c.id === s.cliId)?.type,
  }));

  const selectedAgent = agentList.find((a) => a.id === sid) || null;
  const wsName = group ? group.name : (activeKey || '工作区');

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
        <${AgentCanvas}
          agents=${agentList}
          positions=${layout.agentPositions}
          activeAgentId=${sid}
          onSelectAgent=${_handleSelectAgent}
          onSaveLayout=${_handleSaveLayout}
        />
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
