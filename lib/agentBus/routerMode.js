// Router mode — collapse the full ~68-tool agent-bus catalog into 3 constant,
// tiny-schema tools so the Claude Code system prompt's tool-definition block
// stays stable across turns (and across MCP connect/disconnect churn).
//
// Why this matters: Anthropic prompt caching is prefix-matched. The tool
// schemas sit at the FRONT of the system prompt. When agent-bus (SSE) flaps
// mid-session, the tool list Claude Code saw at boot differs from what it sees
// after reconnect → every subsequent request misses the cache. Collapsing to a
// constant 3-tool surface removes agent-bus from that equation entirely.
//
// Constraint: check_inbox MUST stay a standalone tool — notificationsWake.js
// injects the literal text `check_inbox[BOOS]` into agent PTYs and Claude Code
// resolves that against its known tool names. Router mode keeps check_inbox,
// and routes every other tool through agent_bus_call.
//
// The 2 router tools:
//   agent_bus_list_tools — on demand: returns the catalog (names + short
//     descriptions). Optional `tool_name` returns a single full schema.
//   agent_bus_call       — dispatch any agent-bus tool by name + args.
//
// Env: BOOS_MCP_ROUTER_MODE=1 (default) | 0
//   When 0, tools/list returns the full catalog (legacy behavior).

'use strict';

// ── mode detection ──────────────────────────────────────────────────────

function isRouterMode() {
  return process.env.BOOS_MCP_ROUTER_MODE !== '0';
}

// ── router tool schemas (constant, tiny) ────────────────────────────────

// check_inbox is intentionally a standalone tool (PTY wake contract).
const ROUTER_TOOLS = [
  {
    name: 'check_inbox',
    description:
      'Check your FIFO inbox for pending tasks. Pops the oldest, marks it in_progress, returns it. ' +
      'Always returns immediately (no polling). BOOS wakes you by injecting `check_inbox[BOOS]` ' +
      'into your terminal — call this when you see that prompt. Source tagging: your own calls ' +
      'return source="check_inbox[<your-uid>]".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agent_bus_list_tools',
    description:
      'Discover the agent-bus tool catalog. Returns every available tool name with a one-line ' +
      'description (compact — schemas NOT included). Pass `tool_name` to fetch a single tool\'s ' +
      'full JSON schema. Use this to decide which tool to call, then invoke it via agent_bus_call.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'Optional. If set, returns the full JSON schema for this single tool instead of the compact catalog.',
        },
      },
      required: [],
    },
  },
  {
    name: 'agent_bus_call',
    description:
      'Invoke any agent-bus tool by name. First discover available tools via agent_bus_list_tools ' +
      '(and fetch the target schema with tool_name). Examples: send_task, respond_task, register_agent, ' +
      'dag_create, request_decision, wake_agent, goal_create.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'The agent-bus tool to invoke, e.g. "send_task".' },
        args: { type: 'object', description: 'Arguments for the tool, per its JSON schema (from agent_bus_list_tools).' },
      },
      required: ['tool_name', 'args'],
    },
  },
];

module.exports = { isRouterMode, ROUTER_TOOLS };
