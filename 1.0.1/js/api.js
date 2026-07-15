// Fetch wrapper + every loader. Loaders push into signals from ./state.js.
// Cross-origin (hosted frontend → local backend) flows through httpBase().

import { signal } from '@preact/signals';
import * as S from './state.js';
import { httpBase, apiAuthHeaders, isRemoteAccess, estimateTermSize } from './backend.js';
import { T } from './i18n.js';

// Global pending-approval signal. Flipped to true whenever any /api
// call returns 403 {pending:true}; PendingApprovalOverlay watches this
// and shows the blocking screen. We also stash the server's record so
// the overlay can display "we recorded you at HH:MM" detail.
export const pendingDevice = signal(null);

export function surfaceRemoteGateFailure(status, json = {}) {
  if (!isRemoteAccess()) return;
  if (status === 403 && json && (json.pending || json.rejected)) {
    // Merge into the existing pendingDevice rather than overwriting
    // so the "we recorded you at HH:MM" detail (only present on the
    // initial /me hit, not subsequent gate 403s) survives. Without
    // this merge, the first failing /api/sessions tick after the
    // overlay mounts wipes the firstSeen timestamp and the copy
    // reverts to a generic "The host machine got your request".
    const prev = pendingDevice.value || {};
    pendingDevice.value = { ...prev, ...json, at: Date.now() };
  } else if (status === 401) {
    // Server doesn't recognise our device — either fresh page load
    // (no /api/devices/me hit yet) or our record got pruned (24h
    // pending TTL) AND our token no longer matches the host's
    // current one. PendingApprovalOverlay's /me poll will try to
    // re-register; on token mismatch /me itself 401s and the
    // overlay flips into "token expired" state. We just nudge the
    // overlay alive here.
    const prev = pendingDevice.value || {};
    pendingDevice.value = { ...prev, pending: true, at: Date.now() };
  }
}

export async function api(method, url, body) {
  const opts = {
    method,
    headers: apiAuthHeaders({ 'Content-Type': 'application/json' }),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(httpBase() + url, opts);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) {
    // Surface device-approval pending state. Only matters on remote
    // tabs — host's loopback browser never gets a 401/403 from these
    // checks.
    surfaceRemoteGateFailure(r.status, json);
    throw new Error(json.error || `HTTP ${r.status}`);
  }
  // PendingApprovalOverlay clears pendingDevice itself based on the
  // /api/devices/me body (which can return 200 with status:'pending'
  // since that endpoint is gate-exempt). Doing an auto-clear here on
  // any 2xx would race the overlay's poll and dismiss it prematurely.
  return json;
}

export async function loadConfig() {
  const [cfg, caps] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/capabilities').catch(() => ({ webTerminal: false })),
  ]);
  S.config.value = cfg;
  S.capabilities.value = caps;
}

// Update an existing CLI by id. patch is shallow-merged into the record.
export async function updateCli(id, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  // Built-in CLIs lock down structural fields (id + builtin flag) but
  // allow command edits — users routinely need to point at an absolute
  // path (e.g. C:\Users\you\.local\bin\claude.exe) or a wrapper script
  // when the bare name isn't on the spawn-time PATH.
  if (target?.builtin) {
    delete patch.id;
    delete patch.builtin;
  }
  const toArr = (v, fallback) => Array.isArray(v) ? v :
    typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : fallback;
  const next = {
    ...cfg,
    clis: (cfg.clis || []).map((c) => c.id === id ? {
      ...c, ...patch,
      args: toArr(patch.args, c.args),
      resumeLatestArgs: toArr(patch.resumeLatestArgs, c.resumeLatestArgs),
      resumePickerArgs: toArr(patch.resumePickerArgs, c.resumePickerArgs),
      shell: ['direct', 'pwsh', 'cmd'].includes(patch.shell ?? c.shell) ? (patch.shell ?? c.shell) : 'direct',
    } : c),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

// Probe a (possibly-unsaved) CLI config: spawn its command with
// `--version`, capture output, see if it looks like the claimed type.
// `args` is intentionally ignored server-side — runtime flags can
// disturb a quick probe.
export async function testCli({ command, shell, type }) {
  return api('POST', '/api/clis/test', { command, shell, type });
}

export async function deleteCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const target = (cfg.clis || []).find((c) => c.id === id);
  if (target?.builtin) throw new Error(T.api.builtinCantDelete(target.name));
  const clis = (cfg.clis || []).filter((c) => c.id !== id);
  if (clis.length === 0) throw new Error(T.api.cantDeleteLastCli);
  const next = { ...cfg, clis };
  if (next.defaultCliId === id) next.defaultCliId = clis[0].id;
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function updateRepo(name, patch) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = {
    ...cfg,
    repos: (cfg.repos || []).map((r) => r.name === name ? {
      ...r,
      name: (patch.name ?? r.name).trim(),
      url: (patch.url ?? r.url).trim(),
      defaultSelected: patch.defaultSelected ?? r.defaultSelected,
    } : r),
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function deleteRepo(name) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const next = { ...cfg, repos: (cfg.repos || []).filter((r) => r.name !== name) };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
}

export async function setDefaultCli(id) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const saved = await api('PUT', '/api/config', { ...cfg, defaultCliId: id });
  S.config.value = saved;
}

// Add a new CLI to config.clis and return its id. Generates a fresh id
// from the command name + an integer suffix when collisions exist.
export async function createCli({ name, command, args, resumeLatestArgs, resumePickerArgs, shell, type }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const base = (name || command || 'cli').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cli';
  let id = base, n = 1;
  while ((cfg.clis || []).some((c) => c.id === id)) { id = `${base}-${++n}`; }
  const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);
  const next = {
    ...cfg,
    clis: [...(cfg.clis || []), {
      id,
      name: (name || command || id).trim(),
      command: (command || '').trim(),
      args: toArr(args),
      resumeLatestArgs: toArr(resumeLatestArgs),
      resumePickerArgs: toArr(resumePickerArgs),
      shell: ['direct', 'pwsh', 'cmd'].includes(shell) ? shell : 'direct',
      type: ['claude', 'codex', 'copilot', 'other'].includes(type) ? type : 'other',
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return id;
}

// Add a new repo to config.repos. Repos are addressed by name (which must
// be unique). Returns the name on success, throws on duplicate.
export async function createRepo({ name, url, defaultSelected }) {
  const cfg = S.config.value || (await api('GET', '/api/config'));
  const cleanName = (name || '').trim();
  const cleanUrl = (url || '').trim();
  if (!cleanName) throw new Error(T.api.repoNameRequired);
  if (!cleanUrl) throw new Error(T.api.repoUrlRequired);
  if ((cfg.repos || []).some((r) => r.name === cleanName)) {
    throw new Error(T.api.repoExists(cleanName));
  }
  const next = {
    ...cfg,
    repos: [...(cfg.repos || []), {
      name: cleanName,
      url: cleanUrl,
      defaultSelected: !!defaultSelected,
    }],
  };
  const saved = await api('PUT', '/api/config', next);
  S.config.value = saved;
  return cleanName;
}

export async function loadSessions() {
  const r = await api('GET', '/api/sessions');
  S.sessions.value = r.sessions || [];
  try { localStorage.setItem('boos.sessions-cache', JSON.stringify(S.sessions.value)); } catch {}
}

export async function loadDeletedSessions() {
  const r = await api('GET', '/api/sessions/deleted');
  S.deletedSessions.value = r.sessions || [];
  try { localStorage.setItem('boos.deleted-sessions-cache', JSON.stringify(S.deletedSessions.value)); } catch {}
}

export async function loadFolders() {
  const r = await api('GET', '/api/folders');
  S.folders.value = (r.folders || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  try { localStorage.setItem('boos.folders-cache', JSON.stringify(S.folders.value)); } catch {}
}

export async function createFolder(name) {
  const r = await api('POST', '/api/folders', { name });
  await loadFolders();
  return r.folder;
}

export async function renameFolder(id, name) {
  const r = await api('PUT', `/api/folders/${id}`, { name });
  await loadFolders();
  return r.folder;
}

export async function deleteFolder(id) {
  await api('DELETE', `/api/folders/${id}`);
  await Promise.all([loadFolders(), loadSessions()]);
}

export async function reorderFolders(ids) {
  const r = await api('POST', '/api/folders/reorder', { ids });
  await loadFolders();
  return r.folders;
}

/** Set or clear a folder's rootPath sandbox. Pass rootPath=null to clear. */
export async function setFolderRootPath(folderId, rootPath) {
  const r = await api('PUT', `/api/folders/${encodeURIComponent(folderId)}/root-path`, { rootPath });
  await loadFolders();
  return r;
}

export async function setSessionFolder(sessionId, folderId) {
  await api('PUT', `/api/sessions/${sessionId}`, { folderId: folderId || null });
  await loadSessions();
}

export async function reorderSessions(folderId, ids) {
  await api('POST', '/api/sessions/reorder', { folderId: folderId || null, ids });
  await loadSessions();
}

export async function setSessionTitle(sessionId, title) {
  await api('PUT', `/api/sessions/${sessionId}`, { title });
  await loadSessions();
}

export async function switchSessionCli(sessionId, cliId) {
  const r = await api('POST', `/api/sessions/${sessionId}/switch-cli`, { cliId });
  resumeFailed.delete(sessionId);
  await loadSessions();
  return r;
}

export async function stopSession(sessionId) {
  const r = await api('POST', `/api/sessions/${sessionId}/stop`);
  resumeFailed.delete(sessionId);
  await loadSessions();
  return r.session;
}

export async function deleteSession(sessionId) {
  await api('DELETE', `/api/sessions/${sessionId}`);
  await Promise.all([loadSessions(), loadDeletedSessions(), loadWorkspaces()]);
}

export async function restoreSession(sessionId) {
  const r = await api('POST', `/api/sessions/${sessionId}/restore`);
  resumeFailed.delete(sessionId);
  await Promise.all([loadSessions(), loadDeletedSessions(), loadWorkspaces()]);
  return r.session;
}

// Open the session's working directory in the user's configured editor
// (Settings → Editor, default `code`). Returns { editor, cwd } so the
// caller can surface which editor it launched.
export function openSessionInEditor(sessionId) {
  return api('POST', `/api/sessions/${sessionId}/open-editor`);
}

// Per-session in-flight resume promise. Sidebar.onClick and the
// SessionsPage auto-resume effect can both fire for the same exited
// session in the same tick (clicking an exited row mounts SessionsPage
// which runs its effect AND awaits Sidebar's own POST). Without this
// dedup the backend gets two concurrent /resume requests and may spawn
// two PTYs against the same record. Cleared on resolve/reject.
const resumeInFlight = new Map(); // sessionId → Promise
// Sticky failure cache: once a resume fails, subsequent calls reject
// immediately with the cached error until clearResumeFailure(id) is
// called. Stops the SessionsPage auto-resume effect from looping on a
// session whose CLI keeps exiting (bad command, missing flag, etc.).
const resumeFailed = new Map(); // sessionId → Error

export function clearResumeFailure(sessionId) {
  resumeFailed.delete(sessionId);
}

export function resumeSession(sessionId) {
  const failed = resumeFailed.get(sessionId);
  if (failed) return Promise.reject(failed);
  const cached = resumeInFlight.get(sessionId);
  if (cached) return cached;
  const p = (async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/resume`, {
      // Resolved terminal theme → backend sets a matching COLORFGBG so the
      // CLI's light/dark auto-detection follows the boos terminal.
      theme: document.documentElement.dataset.theme,
      // Seed the PTY at the pane's real size so alt-screen CLIs (claude)
      // don't lay out at node-pty's 30-row default and get stranded short.
      ...(estimateTermSize() || {}),
    });
    await loadSessions();
    return r.launched;
  })();
  resumeInFlight.set(sessionId, p);
  p.then(
    () => { resumeInFlight.delete(sessionId); },
    (e) => { resumeInFlight.delete(sessionId); resumeFailed.set(sessionId, e); },
  );
  return p;
}

const resumePickerInFlight = new Map(); // sessionId -> Promise

export function resumeSessionFromPicker(sessionId) {
  resumeFailed.delete(sessionId);
  const cached = resumePickerInFlight.get(sessionId);
  if (cached) return cached;
  const p = (async () => {
    const r = await api('POST', `/api/sessions/${sessionId}/resume-picker`, {
      theme: document.documentElement.dataset.theme,
      ...(estimateTermSize() || {}),
    });
    await loadSessions();
    return r.launched;
  })();
  resumePickerInFlight.set(sessionId, p);
  p.then(
    () => { resumePickerInFlight.delete(sessionId); },
    () => { resumePickerInFlight.delete(sessionId); },
  );
  return p;
}

// ---- load existing on-disk sessions ("Load session" / adopt) ----
// Scan ~/.claude / <CODEX_HOME> / ~/.copilot for past conversations. type is
// 'all' | 'claude' | 'codex' | 'copilot'; the modal paginates via offset/limit.
export async function listLocalCliSessions({ type = 'all', offset = 0, limit = 30 } = {}) {
  const qs = new URLSearchParams({ type, offset: String(offset), limit: String(limit) });
  return api('GET', `/api/cli-sessions?${qs.toString()}`);
}

// Import a Claude session by its UUID alone. Much simpler than adoptSession:
// the user just pastes the conversation ID; the backend discovers the cwd.
export async function importSessionById(cliSessionId) {
  const r = await api('POST', '/api/sessions/import-by-id', { cliSessionId });
  await Promise.all([loadSessions(), loadWorkspaces()]);
  return r;
}

// Create a boos record that resumes an existing on-disk session. Doesn't
// spawn — the sidebar row shows "exited" until the user clicks it, at which
// point the normal resume flow reattaches via cli.resumeIdArgs.
export async function adoptSession({ cliId, cliSessionId, cwd, title, folderId }) {
  const r = await api('POST', '/api/sessions/adopt', { cliId, cliSessionId, cwd, title, folderId });
  await Promise.all([loadSessions(), loadWorkspaces()]);
  return r;
}

export async function loadWorkspaces() {
  const r = await api('GET', '/api/workspaces');
  S.workspaces.value = r.workspaces;
}

export async function deleteWorkspace(name) {
  await api('DELETE', `/api/workspaces/${encodeURIComponent(name)}`);
}

// ── workspace layout (agent node canvas) ──────────────────────────

/**
 * Load the agent canvas layout for a workspace.
 * @param {string} workspaceName
 * @returns {Promise<{agentPositions:Record<string,{x,y}>, splitRatio:number, version:number}>}
 */
export async function loadWorkspaceLayout(workspaceName) {
  try {
    return await api('GET', `/api/workspaces/${encodeURIComponent(workspaceName)}/layout`);
  } catch {
    return { agentPositions: {}, splitRatio: 0.5, version: 1 };
  }
}

/**
 * Save the agent canvas layout for a workspace (partial merge).
 * @param {string} workspaceName
 * @param {{ agentPositions?: Record<string,{x:number,y:number}>, splitRatio?: number }} data
 */
export async function saveWorkspaceLayout(workspaceName, data) {
  return api('PUT', `/api/workspaces/${encodeURIComponent(workspaceName)}/layout`, data);
}

export async function refreshAll() {
  await Promise.all([
    loadSessions(),
    loadDeletedSessions(),
    loadFolders(),
    loadWorkspaces(),
  ]);
  S.lastRefreshAt.value = Date.now();
}

export async function restartBackend() {
  return api('POST', '/api/restart');
}

// ── Decisions (decision-log system) ─────────────────────────────

export async function fetchDecisions(status = 'open') {
  const qs = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  const r = await api('GET', `/api/decisions${qs}`);
  S.decisions.value = r.decisions || [];
  return S.decisions.value;
}

export async function getDecisionContent(decisionId) {
  return api('GET', `/api/decisions/${encodeURIComponent(decisionId)}`);
}

export async function approveDecision(decisionId) {
  const r = await api('POST', `/api/decisions/${encodeURIComponent(decisionId)}/approve`);
  await fetchDecisions();
  return r;
}

export async function rejectDecision(decisionId, comment) {
  const r = await api('POST', `/api/decisions/${encodeURIComponent(decisionId)}/reject`, { comment });
  await fetchDecisions();
  return r;
}

export async function replyDecision(decisionId, body) {
  const r = await api('POST', `/api/decisions/${encodeURIComponent(decisionId)}/reply`, { body });
  await fetchDecisions();
  return r;
}

let consecutiveOffline = 0;
export async function pollHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(httpBase() + '/api/health', { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    consecutiveOffline = 0;
    S.serverHealth.value = { state: 'online', version: j.version, pid: j.pid, failureCount: 0 };
    if (!S.hasBootedOnline.value) S.hasBootedOnline.value = true;
  } catch (e) {
    consecutiveOffline++;
    S.serverHealth.value = {
      state: 'offline',
      error: String(e.message || e),
      failureCount: consecutiveOffline,
    };
  } finally {
    clearTimeout(t);
  }
}

// ── Sprint 11: BNTP command API ─────────────────────────────────────

/** Send a BNTP command for an agent via agent-bus. */
export async function sendAgentCommand(command, sessionId) {
  return api('POST', '/api/agents/commands', { command, sessionId });
}

// ── Sprint 9: Agent State API (agent-bus ↔ canvas bridge) ──────────

/** Fetch merged agent-bus + BOOS session state. */
export async function fetchAgents() {
  const r = await api('GET', '/api/agents');
  return r;
}

/**
 * Subscribe to agent state changes via SSE.
 * Calls onActivity({sessionId, activity, uid, name, pending}) on each event.
 * Returns an unsubscribe function.
 */
export function subscribeAgentEvents(onActivity) {
  const base = httpBase();
  const url = base ? `${base}/api/agents/events` : '/api/agents/events';
  const es = new EventSource(url);

  es.addEventListener('activity', (e) => {
    try { onActivity(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('registry', (e) => {
    try { onActivity({ ...JSON.parse(e.data), type: 'registry' }); } catch {}
  });
  es.addEventListener('snapshot', (e) => {
    try { onActivity({ ...JSON.parse(e.data), type: 'snapshot' }); } catch {}
  });

  es.onerror = () => {
    // EventSource auto-reconnects; no action needed.
  };

  return () => es.close();
}

// ── Sprint 11: Root Agent Inbox ───────────────────────────────────

/** Reply to a root agent inbox task from the DecisionsPage UI. */
// Sprint 13.3 P1 fix: use api() wrapper for auth headers (was raw fetch).
export async function respondRootTask(taskId, result) {
  return api('POST', '/api/decisions/root-respond', { task_id: taskId, result });
}

/** Set agent permission levels for a folder. levels: { "uid": "PM"|"SE" } */
export async function setFolderAgentLevels(folderId, levels) {
  const r = await api('PUT', `/api/folders/${encodeURIComponent(folderId)}/agent-levels`, { levels });
  await loadFolders();
  return r;
}
