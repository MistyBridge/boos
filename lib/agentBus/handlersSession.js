// Infrastructure MCP handlers — session launch, file locks, knowledge base,
// hard constraints engine, and root-agent messaging.
//
// Imported by handlers.js dispatch() for the corresponding switch cases.

'use strict';

// ── Session launch ──────────────────────────────────────────────────────

async function _launchAgentSession(args, ctx) {
  const store = require('./store');
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  const ws = args.workspace || ctx.workspace;
  if (!ws) return { error: 'not attached to a workspace' };

  let agent;
  if (args.agent_uid) {
    agent = store.getAgent(args.agent_uid);
  } else if (args.agent_name) {
    agent = store.findAgentByNameWs(args.agent_name, ws);
  }
  if (!agent) {
    const all = store.listAgentsInWorkspace(ws);
    const key = args.agent_uid || args.agent_name || '?';
    return { error: 'agent "' + key + '" not found in workspace "' + ws + '". Available: ' + all.map((a) => a.name).join(', ') };
  }
  const agentWs = agent.workspace || ws;

  const persistedSessions = require('../persistedSessions');
  const webTerminalMod = require('../webTerminal');
  const allSessions = await persistedSessions.loadAll();

  let existing = null;
  try {
    const boosId = await store.resolveBoosSessionForAgent(agent.uid);
    if (boosId) {
      existing = allSessions.find((s) => s.id === boosId && s.status !== 'deleted');
    }
  } catch {}
  if (!existing) {
    const agentSessionId = store.getSessionByAgentUid(agent.uid);
    if (agentSessionId) {
      existing = allSessions.find((s) => s.id === agentSessionId && s.status !== 'deleted');
    }
  }
  if (!existing) {
    const safeName = agent.name.replace(/[<>:"/\\|?*]/g, '_');
    existing = allSessions.find((s) =>
      (s.workspace === safeName || require('path').basename(s.cwd || '') === safeName) &&
      s.status !== 'deleted',
    );
  }

  if (existing && existing.status === 'running') {
    const term = webTerminalMod.get(existing.id);
    if (term && !term.exitedAt) {
      try {
        await store.writeIdentity(agent.uid, { boos_session_id: existing.id, cwd: existing.cwd, pty_pid: term.meta?.pid || 0 });
        await persistedSessions.update(existing.id, { agentUid: agent.uid });
      } catch {}
      return {
        ok: true, agent_uid: agent.uid, status: 'already_running',
        pid: term.meta && term.meta.pid, boos_session_id: existing.id,
        hint: 'Agent ' + agent.name + ' is already running in session ' + existing.id + '.',
      };
    }
  }

  const { getSpawnSessionRecord } = require('../sessionHelpers');
  const spawnFn = getSpawnSessionRecord();
  if (!spawnFn) {
    return { error: 'spawnSessionRecord not available — BOOS server has not fully initialized yet' };
  }

  const { loadConfig } = require('../config');
  const { findCliById } = require('../cliHelpers');
  const cfg = await loadConfig();
  const cliId = cfg.defaultCliId || (cfg.clis && cfg.clis[0] && cfg.clis[0].id);
  const cli = findCliById(cfg, cliId);
  if (!cli) return { error: 'No CLI configured. Add one in Configure → CLIs.' };

  if (existing) {
    try {
      const launched = await spawnFn({ record: existing, cli, cfg, body: {}, resume: true });
      try {
        await store.writeIdentity(agent.uid, { boos_session_id: existing.id, cwd: existing.cwd, pty_pid: launched?.pid || 0 });
        await persistedSessions.update(existing.id, { agentUid: agent.uid });
      } catch {}
      return {
        ok: true, agent_uid: agent.uid, status: 'resumed',
        pid: launched.pid, boos_session_id: existing.id,
        hint: 'Session ' + existing.id + ' resumed for ' + agent.name + '.',
      };
    } catch (e) {
      return { error: 'Failed to resume session ' + existing.id + ': ' + e.message };
    }
  }

  // Check for pre-configured agent directory.
  const pathMod = require('path');
  const fsPromises = require('node:fs/promises');
  const projectRoot = pathMod.resolve(__dirname, '..', '..');
  const candidateDirs = [];
  if (agent.name === 'HR Agent') {
    candidateDirs.push(pathMod.join(projectRoot, 'HR'));
  }
  candidateDirs.push(pathMod.join(projectRoot, 'claudes', agent.name));
  for (const agentDir of candidateDirs) {
    try {
      const claudeMd = pathMod.join(agentDir, '.claude', 'CLAUDE.md');
      await fsPromises.access(claudeMd);
      const record = await persistedSessions.create({
        cliId: cli.id, cwd: agentDir, workspace: agent.name,
        repos: [], folderId: null, title: agent.name, agentUid: agent.uid,
      });
      try {
        const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
        try {
          await store.writeIdentity(agent.uid, { boos_session_id: record.id, cwd: agentDir, pty_pid: launched?.pid || 0 });
          await persistedSessions.update(record.id, { agentUid: agent.uid });
        } catch {}
        return {
          ok: true, agent_uid: agent.uid, status: 'launched',
          pid: launched.pid, boos_session_id: record.id,
          hint: 'Pre-configured session launched for ' + agent.name + ' from ' + agentDir,
        };
      } catch (e) { /* skip on spawn failure */ }
    } catch {} // ENOENT
  }

  // Fresh workspace + session with auto MCP config injection.
  const { listWorkspaces, findOrCreateWorkspace } = require('../workspace');
  const busyPaths = allSessions.filter((s) => s.status === 'running' && s.cwd).map((s) => s.cwd);
  const existingWs = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
  let workspace = existingWs.find((w) => w.name === agent.name);
  if (!workspace) {
    const r = await findOrCreateWorkspace({ workDir: cfg.workDir, repos: cfg.repos, busyPaths, requireUnused: true });
    workspace = r.workspace;
  }
  const launchCwd = workspace.path;
  const record = await persistedSessions.create({
    cliId: cli.id, cwd: launchCwd, workspace: workspace.name,
    repos: (cfg.repos || []).filter((r) => r.defaultSelected).map((r) => r.name),
    folderId: null, title: agent.name, agentUid: agent.uid,
  });

  // Auto-inject agent-bus MCP config.
  const mcpPath = require('path').join(launchCwd, '.mcp.json');
  try {
    let existingMcp = { mcpServers: {} };
    try {
      const raw = await require('node:fs/promises').readFile(mcpPath, 'utf-8');
      existingMcp = JSON.parse(raw);
    } catch {}
    const sandbox = require('../sandbox');
    const fsConfig = await sandbox.getFilesystemMcpConfig({ folderId: record.folderId, agentUid: agent.uid });
    const merged = {
      ...existingMcp,
      mcpServers: {
        ...(existingMcp.mcpServers || {}),
        'agent-bus': {
          command: 'node',
          args: [require('path').join(require('os').homedir(), '.boos', 'mcp-proxy.js')],
        },
        filesystem: fsConfig,
      },
    };
    await require('node:fs/promises').mkdir(require('path').dirname(mcpPath), { recursive: true });
    await require('node:fs/promises').writeFile(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch {}

  try {
    const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
    try { await persistedSessions.setAgentUid(record.id, agent.uid); } catch {}
    try { await store.writeIdentity(agent.uid, { boos_session_id: record.id, cwd: launchCwd, pty_pid: launched?.pid || 0 }); } catch {}
    return {
      ok: true, agent_uid: agent.uid, status: 'launched',
      pid: launched.pid, boos_session_id: record.id,
      hint: 'New BOOS session created for ' + agent.name + ' — ' + record.id,
    };
  } catch (e) {
    await persistedSessions.markExited(record.id, null);
    return { error: 'Failed to launch session: ' + e.message };
  }
}

// ── File lock handlers ──────────────────────────────────────────────────

async function _requestFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);
  return fl.requestLock(ctx.uid, agent ? agent.name : ctx.uid, args.file_path);
}

async function _releaseFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.releaseLock(ctx.uid, args.file_path);
}

async function _listFileLocks(_args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.listLocks();
}

// ── Knowledge base handlers ─────────────────────────────────────────────

async function _updateKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);
  return kb.writeEntry(args.path, args.content, {
    append: args.append,
    author: agent ? agent.name : ctx.uid,
  });
}

async function _queryKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  if (args.path) return kb.readEntry(args.path);
  if (args.query) return kb.search(args.query);
  return kb.listSection(args.section || null);
}

// ── Constraints engine handlers ─────────────────────────────────────────

async function _constraintsCheck(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return constraints.checkLimits(ctx.uid);
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

async function _constraintsStatus(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return {
      workspace: ctx.workspace || 'boos',
      agents: constraints.workspaceStatus(ctx.workspace || 'boos'),
    };
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

// ── Root agent ──────────────────────────────────────────────────────────

async function _sendToRoot(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const store = require('./store');
  const queue = require('./queue');
  const content = String(args.content || '').slice(0, 8192);
  if (!content.trim()) return { error: 'content is required' };

  const agent = store.getAgent(ctx.uid);
  const ROOT_UID = store.ROOT_UID;

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: agent?.name || 'unknown', intro: agent?.intro || '', workspace: ctx.workspace || '' },
    receiver_uid: ROOT_UID,
    content,
    priority: args.priority || 'normal',
    reply_to: args.reply_to || undefined,
  });

  if (!r.ok) return { error: r.error };
  return { ok: true, task_id: r.task_id, hint: 'Message sent to BOOS Root. Responses delivered via SSE push + auto-wake — no polling needed.' };
}

// ── Internal: wake-before-deliver session launcher ──────────────────────
// Used by notifications.js to auto-launch agent sessions when tasks arrive
// for agents that are registered but have no active PTY.

async function _internalLaunchAgentSession(agentUid, agentName, agentWorkspace) {
  try {
    const store = require('./store');
    const agent = store.getAgent(agentUid) || store.findAgentByNameWs(agentName, agentWorkspace);
    if (!agent) return null;

    const persistedSessions = require('../persistedSessions');
    const webTerminalMod = require('../webTerminal');
    const allSessions = await persistedSessions.loadAll();

    let existing = null;
    try {
      const { getResolver } = require('../identityResolver');
      const boosId = getResolver().canonical(agent.uid);
      if (boosId) {
        existing = allSessions.find((s) => s.id === boosId);
      }
    } catch {}
    if (!existing) {
      const identity = store.getIdentity({ uid: agent.uid });
      if (identity?.boos_session_id) {
        existing = allSessions.find((s) => s.id === identity.boos_session_id);
      }
    }
    if (!existing) {
      const safeName = agent.name.replace(/[<>:"/\\|?*]/g, '_');
      existing = allSessions.find((s) =>
        (s.workspace === safeName || require('path').basename(s.cwd || '') === safeName) &&
        s.status !== 'deleted',
      );
    }

    if (existing && existing.status === 'running') {
      const term = webTerminalMod.get(existing.id);
      if (term && !term.exitedAt) return existing;
    }

    const { getSpawnSessionRecord } = require('../sessionHelpers');
    const spawnFn = getSpawnSessionRecord();
    if (!spawnFn) return null;

    const { loadConfig } = require('../config');
    const { findCliById } = require('../cliHelpers');
    const cfg = await loadConfig();
    const cliId = cfg.defaultCliId || (cfg.clis && cfg.clis[0] && cfg.clis[0].id);
    const cli = findCliById(cfg, cliId);
    if (!cli) return null;

    if (existing) {
      const launched = await spawnFn({ record: existing, cli, cfg, body: {}, resume: true });
      try { await persistedSessions.setAgentUid(existing.id, agent.uid); } catch {}
      try { await store.writeIdentity(agent.uid, { boos_session_id: existing.id, cwd: existing.cwd, pty_pid: launched?.pid || 0 }); } catch {}
      return existing;
    }

    const { listWorkspaces, findOrCreateWorkspace } = require('../workspace');
    const busyPaths = allSessions.filter((s) => s.status === 'running' && s.cwd).map((s) => s.cwd);
    const existingWs = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
    let workspace = existingWs.find((w) => w.name === agent.name);
    if (!workspace) {
      const r = await findOrCreateWorkspace({ workDir: cfg.workDir, repos: cfg.repos, busyPaths, requireUnused: true });
      workspace = r.workspace;
    }
    const launchCwd = workspace.path;
    const record = await persistedSessions.create({
      cliId: cli.id, cwd: launchCwd, workspace: workspace.name,
      repos: (cfg.repos || []).filter((r) => r.defaultSelected).map((r) => r.name),
      folderId: null, title: agent.name, agentUid: agent.uid,
    });
    const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
    try { await persistedSessions.setAgentUid(record.id, agent.uid); } catch {}
    try { await store.writeIdentity(agent.uid, { boos_session_id: record.id, cwd: launchCwd, pty_pid: launched?.pid || 0 }); } catch {}
    return record;
  } catch (e) {
    console.warn('[agent-bus] internalLaunchAgentSession failed for', agentName, e.message);
    return null;
  }
}

module.exports = {
  _launchAgentSession,
  _internalLaunchAgentSession,
  _requestFileLock, _releaseFileLock, _listFileLocks,
  _updateKnowledge, _queryKnowledge,
  _constraintsCheck, _constraintsStatus,
  _sendToRoot,
};
