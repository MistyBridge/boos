// BOOS MCP Tool Definitions
// Each tool conforms to the MCP spec (JSON Schema for input, text content output).
//
// Tool registration pattern:
//   { name: string, description: string, inputSchema: object, handler: async (args) => result }
//
// See: https://modelcontextprotocol.io/specification/draft

'use strict';

// ── MCP stats (tracked across the lifetime of this stdio process) ────

const MCP_STATS = {
  startTime: Date.now(),
  requestCount: 0,
  toolCallCount: 0,
};

function _incrementMcpRequests() { MCP_STATS.requestCount++; }
function _incrementMcpToolCalls() { MCP_STATS.toolCallCount++; }

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Return persisted session counts by status.
 * Requires the sessions.json store to be loadable from DATA_DIR.
 */
async function _getSessionStats() {
  let stats = { total: 0, running: 0, exited: 0, error: 0, sessions: [] };
  try {
    // Use BOOS's own persisted sessions store.
    const persistedSessions = require('../persistedSessions');
    const sessions = await persistedSessions.loadAll();

    stats.total = sessions.length;
    for (const s of sessions) {
      if (s.status === 'running') stats.running++;
      else if (s.status === 'exited') stats.exited++;
      else stats.error++;

      stats.sessions.push({
        id: s.id,
        title: s.title || '',
        cliId: s.cliId || '',
        cwd: s.cwd || '',
        workspace: s.workspace || '',
        status: s.status,
        pid: s.pid || null,
        cliSessionId: s.cliSessionId || null,
        createdAt: s.createdAt || null,
      });
    }
  } catch (err) {
    stats.error++;
    stats._loadError = err.message;
  }
  return stats;
}

/**
 * Load workspace info from BOOS's workspace module.
 */
async function _getWorkspaceInfo() {
  try {
    const workspace = require('../workspace');
    const ws = await workspace.listWorkspaces();
    return {
      workDir: workspace.workDir || null,
      count: Array.isArray(ws) ? ws.length : 0,
      workspaces: Array.isArray(ws) ? ws.map(w => ({
        name: w.name || w,
        path: w.path || w,
        inUse: !!w.inUse,
        repos: Array.isArray(w.repos) ? w.repos.length : 0,
      })) : [],
    };
  } catch {
    return { workDir: null, count: 0, workspaces: [], _error: 'workspace module not loadable' };
  }
}

// ── tool definitions ──────────────────────────────────────────────────

const TOOLS = [

  // ── boos_status ──────────────────────────────────────────────────
  {
    name: 'boos_status',
    description:
      'Get BOOS system status: session counts by status, workspace info, ' +
      'and server health. Returns a summary of running/exited sessions and ' +
      'available workspaces.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler(_args) {
      const sessions = await _getSessionStats();
      const workspaces = await _getWorkspaceInfo();

      return {
        sessions: {
          total: sessions.total,
          running: sessions.running,
          exited: sessions.exited,
          error: sessions.error,
        },
        workspaces: {
          workDir: workspaces.workDir,
          count: workspaces.count,
        },
        server: {
          pid: process.pid,
          uptime: process.uptime(),
          node: process.version,
          platform: process.platform,
        },
      };
    },
  },

  // ── boos_list_sessions ───────────────────────────────────────────
  {
    name: 'boos_list_sessions',
    description:
      'List all persisted BOOS sessions with their status, working directory, ' +
      'and associated CLI. Returns full session list with metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'exited', 'all'],
          description: 'Filter by session status. Default: "all".',
        },
      },
    },
    async handler(args) {
      const stats = await _getSessionStats();
      const filter = args?.status || 'all';
      const sessions = filter === 'all'
        ? stats.sessions
        : stats.sessions.filter(s => s.status === filter);

      return {
        total: stats.sessions.length,
        filtered: sessions.length,
        filter,
        sessions,
      };
    },
  },

  // ── boos_create_workspace ────────────────────────────────────────
  {
    name: 'boos_create_workspace',
    description:
      'Create a new workspace directory under BOOS workspace root. ' +
      'Returns the newly created workspace path. The workspace will be ' +
      'auto-named (ws-N) unless a name is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional workspace name. If omitted, auto-allocates ws-N.',
        },
        repos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of git repo URLs to clone into the workspace.',
        },
      },
    },
    async handler(args) {
      try {
        const workspace = require('../workspace');

        let wsPath;
        if (args?.name) {
          // Create named workspace.
          const path = require('path');
          const fs = require('fs');
          const workDir = workspace.workDir || require('os').homedir() + '/boos-workspaces';
          wsPath = path.join(workDir, args.name);
          fs.mkdirSync(wsPath, { recursive: true });
        } else {
          // Auto-allocate ws-N.
          const result = await workspace.findOrCreateWorkspace('auto');
          wsPath = result.path || result;
        }

        // Clone repos if requested.
        const cloned = [];
        if (Array.isArray(args?.repos) && args.repos.length > 0) {
          try {
            await workspace.ensureReposInWorkspace(wsPath, args.repos);
            cloned.push(...args.repos);
          } catch (e) {
            cloned.push('_error: ' + e.message);
          }
        }

        return {
          created: true,
          path: wsPath,
          name: require('path').basename(wsPath),
          reposCloned: cloned,
        };
      } catch (err) {
        return {
          created: false,
          error: err.message,
        };
      }
    },
  },

  // ── boos_sessions ─────────────────────────────────────────────────
  {
    name: 'boos_sessions',
    description:
      'Get all active BOOS sessions with their id, CLI type, working directory, ' +
      'and status. Useful for discovering which agents are running and where.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler(_args) {
      const stats = await _getSessionStats();
      return {
        total: stats.total,
        running: stats.running,
        sessions: stats.sessions,
      };
    },
  },

  // ── boos_get_session ──────────────────────────────────────────────
  {
    name: 'boos_get_session',
    description:
      'Get detailed info for a single BOOS session by its id. Returns full ' +
      'session metadata including title, CLI type, working directory, workspace, ' +
      'activity timestamps, repos, and upstream CLI session id for exact resume.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The BOOS session id (e.g. "sess-lx3abc-def456"). Required.',
        },
      },
      required: ['id'],
    },
    async handler(args) {
      try {
        const persistedSessions = require('../persistedSessions');
        const session = await persistedSessions.get(args.id);

        if (!session) {
          return { found: false, id: args.id, error: 'Session not found' };
        }

        // Compute activity-derived fields.
        const now = Date.now();
        const lastActiveAgo = session.lastActiveAt
          ? Math.round((now - session.lastActiveAt) / 1000)
          : null;

        return {
          found: true,
          id: session.id,
          title: session.title || '',
          cliId: session.cliId || '',
          cwd: session.cwd || '',
          workspace: session.workspace || '',
          status: session.status,
          pid: session.pid || null,
          cliSessionId: session.cliSessionId || null,
          manualStopped: !!session.manualStopped,
          repos: session.repos || [],
          folderId: session.folderId || null,
          createdAt: session.createdAt || null,
          lastActiveAt: session.lastActiveAt || null,
          lastActiveAgoSeconds: lastActiveAgo,
          exitedAt: session.exitedAt || null,
          exitCode: session.exitCode ?? null,
        };
      } catch (err) {
        return { found: false, id: args.id, error: err.message };
      }
    },
  },

  // ── boos_terminal_list ────────────────────────────────────────────
  {
    name: 'boos_terminal_list',
    description:
      'List active BOOS terminals (PTY sessions) with their id, working directory, ' +
      'CLI type, pid, and status. Cross-references PTY pool with persisted session ' +
      'records to provide full metadata. Use this to discover which CLI processes ' +
      'are running and where.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'exited', 'all'],
          description: 'Filter by terminal status. "running" = active PTY, "exited" = dead but cached, "all" = both. Default: "running".',
        },
      },
    },
    async handler(args) {
      const filter = args?.status || 'running';

      let terminals = [];
      try {
        const wt = require('../webTerminal');
        const rawList = wt.list(); // [{ id, meta: {cwd, pid, ...}, attached, exitedAt, exitCode }]

        // Cross-reference with persisted sessions to get cliId.
        let sessionMap = new Map();
        try {
          const persistedSessions = require('../persistedSessions');
          const sessions = await persistedSessions.loadAll();
          for (const s of sessions) {
            sessionMap.set(s.id, s);
          }
        } catch {}

        for (const t of rawList) {
          const isExited = !!t.exitedAt;
          const status = isExited ? 'exited' : 'running';

          if (filter !== 'all' && filter !== status) continue;

          const persisted = sessionMap.get(t.id) || {};
          terminals.push({
            id: t.id,
            cwd: t.meta?.cwd || persisted.cwd || '',
            cliId: persisted.cliId || '',
            pid: t.meta?.pid || null,
            status,
            attached: t.attached || 0,
            command: t.meta?.command || '',
            startedAt: t.meta?.startedAt || null,
            exitedAt: t.exitedAt || null,
            exitCode: t.exitCode ?? null,
          });
        }
      } catch (err) {
        return { terminals: [], total: 0, filter, error: err.message };
      }

      return {
        total: terminals.length,
        filter,
        terminals,
      };
    },
  },

  // ── boos_health ───────────────────────────────────────────────────
  {
    name: 'boos_health',
    description:
      'Get BOOS server health status: process pid, uptime, session count, ' +
      'active PTY count, and embedded agent-bus MCP endpoint. Use this to ' +
      'verify BOOS is running and healthy.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler(_args) {
      let ptyCount = 0;
      try {
        const wt = require('../webTerminal');
        ptyCount = typeof wt.count === 'function' ? wt.count() : 0;
      } catch {}

      return {
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        sessions: {
          total: (await _getSessionStats()).total,
          activePTYs: ptyCount,
        },
        agentBus: {
          embedded: true,
          sseEndpoint: '/mcp/sse',
        },
        mcp: {
          transport: 'stdio',
          uptime: Math.round((Date.now() - MCP_STATS.startTime) / 1000),
          requestCount: MCP_STATS.requestCount,
          toolCallCount: MCP_STATS.toolCallCount,
        },
      };
    },
  },
];

module.exports = TOOLS;
module.exports._mcpStats = MCP_STATS;
module.exports._incrementMcpRequests = _incrementMcpRequests;
module.exports._incrementMcpToolCalls = _incrementMcpToolCalls;
