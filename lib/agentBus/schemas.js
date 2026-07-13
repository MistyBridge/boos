// MCP tool JSON Schema definitions for all agent-bus tools.  v2.0.0
//
// Copied from agent-bus/mcp/schemas.js — zero changes needed.

'use strict';

const TOOLS = [
  {
    name: 'register_agent',
    description:
      'Register this agent in a workspace. IDEMPOTENT: same name + workspace always returns the same persistent UID. ' +
      'On reconnection (e.g. after disconnect or server restart), returns your original UID and pending task count. ' +
      'Your identity survives server restarts — tasks queued while offline will be waiting on reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Human-readable role name (e.g. "前端开发工程师"). Used as part of your permanent identity key.' },
        intro:     { type: 'string', description: 'Brief intro describing your role and capabilities for other agents' },
        workspace: { type: 'string', description: 'Workspace name this agent belongs to (e.g. "quant-dashboard")' },
        role:      { type: 'string', enum: ['supervisor', 'worker'], default: 'worker', description: 'Agent role. Supervisor has elevated permissions to manage workflows and other agents. Default: worker.' },
        capabilities: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'List of capability tags (e.g. ["frontend","react","testing"]). Used for workflow auto-matching. Max 10 entries.' },
      },
      required: ['name', 'workspace'],
    },
  },
  {
    name: 'deregister_agent',
    description: 'Permanently remove this agent from the workspace registry. Only works if no active sessions remain.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_agents',
    description: 'List all active agents in the current workspace (only those with recent heartbeat). Agents inactive >5 minutes are hidden but can reconnect.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_task',
    description: 'Send a task/instruction to another agent. Tasks are queued FIFO and persisted — they survive server restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        to_uid:   { type: 'string', description: 'Target agent UID (from list_agents)' },
        content:  { type: 'string', description: 'Task instruction in natural language' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority (default: normal)' },
      },
      required: ['to_uid', 'content'],
    },
  },
  {
    name: 'check_inbox',
    description:
      'Check your FIFO inbox for pending tasks. If found, pops the oldest pending task and marks it in_progress. ' +
      'Tasks persist across server restarts. ' +
      'Supports wait mode: set wait=true to block until a task arrives or timeout_ms expires. ' +
      'When another agent sends you a task while you are waiting, the server pushes a notification and this call returns immediately — no polling needed.',
    inputSchema: {
      type: 'object',
      properties: {
        wait:       { type: 'boolean', description: 'If true, block until a task arrives or timeout expires (default: false). Uses server-side push events — zero polling overhead.' },
        timeout_ms: { type: 'number', description: 'Max wait time in milliseconds when wait=true (default: 30000, max: 120000).' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task you sent that is still pending (not yet picked up by receiver).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel (from send_task response)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'interrupt_task',
    description: 'Interrupt a task you sent that is currently being executed (in_progress).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to interrupt' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'respond_task',
    description: 'Mark a task as completed with your result/answer. Only the assigned receiver can respond.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID you are responding to' },
        result:  { type: 'string', description: 'Your response/result in natural language' },
      },
      required: ['task_id', 'result'],
    },
  },
  {
    name: 'list_my_tasks',
    description: 'List all tasks you have sent or received, sorted newest first. Survives server restarts.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_task',
    description: 'Get full details of a single task by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to look up' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'broadcast',
    description: 'Send a message to all other agents in your workspace simultaneously.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Broadcast message content' },
      },
      required: ['message'],
    },
  },

  // ── Sprint 5: Workflow Engine (Supervisor-only) ─────────────────────
  {
    name: 'define_workflow',
    description:
      'Define a new DAG workflow. Returns a workflow_id used for adding stages and dependencies. ' +
      'Only callable by supervisor agents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (e.g. "Release Pipeline"). Max 128 chars.' },
        description: { type: 'string', description: 'Optional description. Max 512 chars.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_stage',
    description:
      'Add a stage to a draft workflow. Each stage is dispatched to a matched worker agent when its dependencies resolve. ' +
      'Only callable by the workflow owner (supervisor).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID (from define_workflow).' },
        name: { type: 'string', description: 'Stage name (e.g. "Build Frontend"). Max 128 chars.' },
        description: { type: 'string', description: 'Stage description. Max 256 chars.' },
        content: { type: 'string', description: 'Task instruction sent to the assigned agent.' },
        required_capabilities: {
          type: 'array', items: { type: 'string' }, maxItems: 10,
          description: 'Capability tags required. Auto-matches agents. If empty, any worker can be assigned.',
        },
      },
      required: ['workflow_id', 'name', 'content'],
    },
  },
  {
    name: 'add_dependency',
    description:
      'Add a dependency edge between two stages. Stage B dispatched only after Stage A completes. ' +
      'Only callable by workflow owner (supervisor). Workflow must be in "draft" status.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID.' },
        from_stage_id: { type: 'string', description: 'Upstream stage that must complete first.' },
        to_stage_id: { type: 'string', description: 'Downstream stage that depends on upstream.' },
      },
      required: ['workflow_id', 'from_stage_id', 'to_stage_id'],
    },
  },
  {
    name: 'activate_workflow',
    description:
      'Activate a draft workflow. The engine auto-dispatches stages with zero unresolved dependencies to matched workers. ' +
      'As each stage completes, newly-ready stages are dispatched. Only callable by workflow owner (supervisor).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to activate.' },
      },
      required: ['workflow_id'],
    },
  },

  // ── Sprint 5: Decision System ──────────────────────────────────────
  {
    name: 'request_decision',
    description:
      'Write a decision document for human review and continue working (non-blocking). ' +
      'Saved to ~/.boos/decisions/OPEN/. If urgent, triggers Feishu notification. Available to all agents.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Decision title. Max 128 chars.' },
        content: { type: 'string', description: 'Decision document in Markdown (Context, Proposed Decision, Consequences, Alternatives).' },
        urgent: { type: 'boolean', description: 'If true, sends Feishu notification. Default: false.', default: false },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'check_decisions',
    description:
      'Check the status of your pending decision requests. Returns open and recently decided items.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'decided', 'all'], description: 'Filter by status. Default: "open".', default: 'open' },
        limit: { type: 'number', description: 'Max decisions to return. Default: 20.', default: 20 },
      },
      required: [],
    },
  },

  // ── Sprint 5: BOOS Terminal listing ─────────────────────────────────
  {
    name: 'boos_terminal_list',
    description:
      'List all active BOOS PTY terminals with their id, pid, CLI name, workspace, ' +
      'working directory, and timestamps. Returns running and recently-exited terminals. ' +
      'Use this to discover which CLI sessions are active and where they are working.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Sprint 5: Supervisor Privileges ────────────────────────────────
  {
    name: 'assign_task',
    description:
      'Directly assign a task to a specific agent, bypassing capability matching. Only callable by supervisor agents.',
    inputSchema: {
      type: 'object',
      properties: {
        to_uid: { type: 'string', description: 'Target agent UID.' },
        content: { type: 'string', description: 'Task instruction.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority. Default: "normal".', default: 'normal' },
      },
      required: ['to_uid', 'content'],
    },
  },
  {
    name: 'list_all_agents',
    description:
      'List ALL agents in workspace with full metadata (role, capabilities, session count). Only callable by supervisor agents.',
    inputSchema: {
      type: 'object',
      properties: {
        include_stale: { type: 'boolean', description: 'Include agents without recent heartbeat. Default: false.', default: false },
      },
      required: [],
    },
  },
  {
    name: 'kill_worker',
    description:
      'Forcefully deregister a worker agent. Only callable by supervisor agents.',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID to forcefully remove.' },
      },
      required: ['target_uid'],
    },
  },
  {
    name: 'boos_terminal_list',
    description:
      'List all active PTY terminal sessions managed by the BOOS server. Returns id, pid, command, workspace, cwd, and timing info.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

module.exports = { TOOLS };
