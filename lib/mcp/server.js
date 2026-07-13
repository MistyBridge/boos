#!/usr/bin/env node
// BOOS MCP Server — stdio transport for Claude Code / MCP clients.
//
// Implements the MCP protocol (JSON-RPC 2.0 over stdin/stdout) as a
// lightweight server that exposes BOOS management tools to agents.
//
// Protocol flow:
//   1. Client sends `initialize` request
//   2. Server responds with capabilities
//   3. Client sends `notifications/initialized`
//   4. Client calls `tools/list` → `tools/call` for tool execution
//
// Usage:
//   node lib/mcp/server.js
//   # Or via claude_desktop_config.json → mcpServers.boos.command entry
//
// See: https://modelcontextprotocol.io/specification/draft

'use strict';

const readline = require('readline');
const TOOLS = require('./tools');

// ── server info ────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'boos',
  version: require('../../package.json').version || '0.0.0',
};

const PROTOCOL_VERSION = '2024-11-05';

// ── JSON-RPC 2.0 dispatcher ────────────────────────────────────────────

/**
 * Handle a single JSON-RPC request and return the response object.
 * Returns null for notifications (no response needed).
 *
 * @param {object} req — JSON-RPC 2.0 request { jsonrpc, id?, method, params? }
 * @returns {Promise<object|null>} JSON-RPC 2.0 response
 */
async function _handleRequest(req) {
  const { method, params, id } = req;

  // Track MCP stats (exposed via boos_health).
  TOOLS._incrementMcpRequests();
  if (method === 'tools/call') TOOLS._incrementMcpToolCalls();

  // Notifications (no id) — process but don't respond.
  const hasId = id !== undefined && id !== null;

  try {
    switch (method) {
      // ── lifecycle ──────────────────────────────────────────────
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},  // supports tools/list + tools/call
            },
            serverInfo: SERVER_INFO,
          },
        };

      case 'notifications/initialized':
        // No response for notifications.
        return null;

      // ── tools ──────────────────────────────────────────────────
      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: TOOLS.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};

        const tool = TOOLS.find(t => t.name === toolName);
        if (!tool) {
          return {
            jsonrpc: '2.0', id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          };
        }

        const result = await tool.handler(args);
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      }

      // ── ping ───────────────────────────────────────────────────
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0', id: hasId ? id : null,
      error: { code: -32603, message: err.message },
    };
  }
}

// ── stdio transport ────────────────────────────────────────────────────

/**
 * Start the MCP server on stdin/stdout.
 * Reads newline-delimited JSON-RPC requests from stdin,
 * writes JSON-RPC responses to stdout.
 *
 * Stderr is reserved for logging (not protocol data) per MCP spec.
 */
function start() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      // Invalid JSON — skip silently (MCP spec says server may ignore).
      return;
    }

    // Validate JSON-RPC 2.0 envelope.
    if (!req || req.jsonrpc !== '2.0' || !req.method) {
      _write({ jsonrpc: '2.0', id: req?.id || null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }

    const resp = await _handleRequest(req);
    if (resp) {
      _write(resp);
    }
  });

  rl.on('close', () => {
    // Client disconnected — exit cleanly.
    process.exit(0);
  });

  // Log server start to stderr (safe — MCP clients ignore stderr).
  console.error(`[boos:mcp] server started (stdio) · version=${SERVER_INFO.version} · pid=${process.pid}`);
}

function _write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── entry ─────────────────────────────────────────────────────────────

start();
