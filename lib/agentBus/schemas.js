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
        project: { type: 'string', description: 'Optional project name this agent belongs to (e.g. "boos-core"). Agents in different projects are isolated from each other. Default: null (legacy workspace-wide visibility).' },
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
    description: 'List all active agents in the current workspace. Agents persist indefinitely (no heartbeat timeout).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_task',
    description: 'Send a task/instruction to another agent. Tasks are queued FIFO and persisted. If to_uid is omitted and required_capabilities is set, auto-routes to the best matching agent. Falls back to general assistant if no specialist matches.',
    inputSchema: {
      type: 'object',
      properties: {
        to_uid:   { type: 'string', description: 'Target agent UID (from list_agents). Optional — omit to auto-route by required_capabilities.' },
        content:  { type: 'string', description: 'Task instruction in natural language' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority (default: normal)' },
        reply_to: { type: 'string', description: 'Optional parent task_id for threaded replies' },
        required_capabilities: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Required capability tags for auto-routing. If set without to_uid, matches to best agent. Used for work boundary enforcement.' },
        metadata: { type: 'object', description: 'Optional structured metadata for typed task workflows (e.g. recruitment, modify_agent). Default: null.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'check_inbox',
    description:
      'Check your FIFO inbox for pending tasks. If found, pops the oldest pending task and marks it in_progress. ' +
      'Tasks persist across server restarts. Always returns immediately — event-driven model: ' +
      'when another agent sends you a task, the server pushes an SSE notification and auto-wakes you via PTY injection. ' +
      'No polling needed. Call this after being woken by wake_agent or after receiving an SSE inbox_updated event.',
    inputSchema: {
      type: 'object',
      properties: {},
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
        metadata: { type: 'object', description: 'Optional structured metadata for the response (e.g. onboarding report, validation results). Default: null.' },
      },
      required: ['task_id', 'result'],
    },
  },
  {
    name: 'retry_task',
    description: 'Re-submit a completed or cancelled task for retry. Resets status to pending and bumps retry_count. Max 3 retries — the 4th attempt marks the task exhausted (permanently failed).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to retry' },
      },
      required: ['task_id'],
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
        scope: { type: 'string', enum: ['workspace', 'project'], description: 'Broadcast scope. "workspace" sends to all agents, "project" limits to same-project agents. Default: "workspace".', default: 'workspace' },
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
      'NON-BLOCKING by default. Write a decision document for async human review. ' +
      'Agents should NOT wait — continue working on other tasks. ' +
      'Decision results arrive via SSE + auto-wake when human answers. ' +
      'If blocking_task_id is passed, that task is blocked until answered. ' +
      'Saved to ~/.boos/decisions/OPEN/. If urgent, triggers Feishu notification.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Decision title. Max 128 chars.' },
        content: { type: 'string', description: 'Decision document in Markdown (Context, Proposed Decision, Consequences, Alternatives).' },
        urgent: { type: 'boolean', description: 'If true, sends Feishu notification. Default: false.', default: false },
        blocking_task_id: { type: 'string', description: 'Optional task_id to block while awaiting human decision. The task will auto-resume when the decision is answered.' },
      },
      required: ['title', 'content'],
    },
  },

  // ── Sprint 6: Agent Wake-Up ────────────────────────────────────────
  {
    name: 'wake_agent',
    description:
      'Wake up a sleeping/idle agent by sending a terminal notification. ' +
      'The target agent will receive a prompt to check their inbox. ' +
      'Call this after sending a task to ensure the receiver acts on it immediately. ' +
      'Only works for agents with an active BOOS PTY session. ' +
      'Authorization: caller must be a supervisor AND in the same workspace as the target. ' +
      'Cross-workspace wake is rejected. Non-supervisors receive an error.',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'UID of the agent to wake up (from list_agents)' },
        urgency: { type: 'string', enum: ['normal', 'urgent'], description: 'Urgency level. Urgent messages bypass debounce. Default: normal.', default: 'normal' },
        message: { type: 'string', description: 'Optional custom wake message (max 256 chars). If omitted, a default message is used.' },
        context: { type: 'string', description: 'Optional task summary for context display (e.g. "Task #task_xxx: Review PR"). Appended to the wake message.' },
      },
      required: ['target_uid'],
    },
  },

  // ── Sprint 8 Wave 4: Wake All ───────────────────────────────────────
  {
    name: 'wake_all',
    description:
      'Wake up all idle agents in the workspace. Sends a terminal notification to every agent with an active PTY session. ' +
      'Useful for all-hands announcements or urgent workspace-wide coordination. Only callable by supervisor agents.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Wake message (max 256 chars). If omitted, a default message is used.' },
        urgency: { type: 'string', enum: ['normal', 'urgent'], description: 'Urgency level. Default: normal.', default: 'normal' },
        exclude_self: { type: 'boolean', description: 'Exclude the caller from the wake. Default: true.', default: true },
      },
      required: [],
    },
  },

  // ── Sprint 28: Agent Identity Cards ────────────────────────────────────
  {
    name: 'list_agent_cards',
    description:
      'List full identity cards for all registered agents in the current workspace. ' +
      'Each card includes: uid, name, intro, role, capabilities, project, PM scope, ' +
      'registration time, last seen, online status, active task count, and whether ' +
      'the agent has an active PTY session. Supervisor-only — workers receive an error.',
    inputSchema: {
      type: 'object',
      properties: {
        include_stale: { type: 'boolean', description: 'Include agents without recent heartbeat. Default: false.', default: false },
      },
      required: [],
    },
  },

  // ── Sprint 9: Agent Peer Launch ──────────────────────────────────────
  // Sprint 30: agent_uid is the canonical index; agent_name is deprecated.
  {
    name: 'launch_agent_session',
    description:
      'Launch or resume a BOOS session for an agent. Any agent can call this to bring an offline colleague back online. ' +
      'Prefer agent_uid as the canonical index. No supervisor restriction — peer-to-peer session management.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_uid: { type: 'string', description: 'Agent UID (canonical, preferred). e.g. "agent_XlkuC2xcWqn4"' },
        agent_name: { type: 'string', description: '@deprecated Agent name. Use agent_uid instead.' },
        workspace: { type: 'string', description: 'Workspace name. Default: current workspace.' },
      },
    },
  },

  // ── Sprint 8 Wave 1: PM Identity System ──────────────────────────────
  {
    name: 'set_pm',
    description:
      'Assign an agent as Project Manager for one or more projects. ' +
      'PMs have supervisor-like permissions within their project scope (assign tasks, list all agents). ' +
      'Only callable by workspace supervisor.',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID to assign PM role to.' },
        projects: {
          type: 'array', items: { type: 'string' }, maxItems: 20,
          description: 'List of project names this agent will manage. Pass empty array to revoke PM role.',
        },
      },
      required: ['target_uid', 'projects'],
    },
  },
  {
    name: 'assign_to_project',
    description:
      'Assign an agent to a specific project for access control. ' +
      'Agents in different projects cannot see or send tasks to each other. ' +
      'Callable by supervisor or the PM of the target project.',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID to assign.' },
        project: { type: 'string', description: 'Project name to assign the agent to.' },
      },
      required: ['target_uid', 'project'],
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

  // ── Sprint 10 R13: File Lock Management ────────────────────────────
  {
    name: 'request_file_lock',
    description:
      'Request exclusive write lock on a file. Only one agent can hold the lock on a specific file at a time. ' +
      'Locks auto-expire after 5 minutes. Call this BEFORE modifying any file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or repo-relative file path to lock.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'release_file_lock',
    description:
      'Release a file lock you previously acquired. Call this AFTER you finish modifying the file. ' +
      'Supervisors can force-release any lock.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path to unlock.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'list_file_locks',
    description: 'List all currently active file locks in the workspace.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ── Sprint 10 R12: Shared Knowledge Base ──────────────────────────
  {
    name: 'update_knowledge',
    description:
      'Write to the shared agent knowledge base. Use this after completing a task to record findings, ' +
      'fixes, patterns, or architectural decisions. The knowledge base is at ~/.boos/knowledge/. ' +
      'Sections: architecture, bugs, patterns, decisions, agents. ' +
      'Use append=true to add to existing entries without overwriting.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within knowledge base (e.g. "bugs/soft-lock.md").' },
        content: { type: 'string', description: 'Markdown content to write.' },
        append: { type: 'boolean', description: 'If true, append to existing content. Default: false.', default: false },
        section: { type: 'string', description: 'Knowledge section for search/list. One of: architecture, bugs, patterns, decisions, agents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'query_knowledge',
    description:
      'Search the shared knowledge base for existing information. Use this BEFORE starting a task ' +
      'to check if a colleague has already solved a similar problem.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (min 2 chars). Searches all KB content.' },
        section: { type: 'string', description: 'Optional section to limit search to (architecture/bugs/patterns/decisions/agents).' },
      },
      required: ['query'],
    },
  },
  // Sprint 12 R15: Hard Constraints Engine
  {
    name: 'constraints_check',
    description:
      '检查 agent 是否能接受新任务。硬约束引擎自动执行并发上限检查（C5: max 3 in_progress）。' +
      '在 send_task 或 accept 任务前调用，避免无效路由。',
    inputSchema: {
      type: 'object',
      properties: {
        task_content: { type: 'string', description: '待分配任务的简要描述（用于上下文日志）' },
      },
      required: [],
    },
  },
  {
    name: 'constraints_status',
    description:
      '查询当前 workspace 所有 agent 的约束状态。返回每个 agent 的 in_progress/pending 计数、' +
      '是否可接受新任务、被哪些规则阻止。PM 用于负载可视化和调度决策。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Sprint 13: Root Agent 工具 ──────────────────────────────────────────

  {
    name: 'send_to_root',
    description:
      '向 BOOS Root Agent（人类）发送消息。Agent 使用此工具请求人类关注或决策，' +
      '消息将出现在决策区 UI 中。等同于 send_task(to_uid=agent_root)。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '消息内容，支持 Markdown。',
          maxLength: 8192,
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '优先级。默认: normal。high 会触发紧急标记。',
        },
        reply_to: {
          type: 'string',
          description: '关联的 decision ID（可选），用于追踪决策回复链。',
        },
      },
      required: ['content'],
    },
  },

  // ── Sprint 31: DAG Task System ───────────────────────────────────────

  {
    name: 'dag_create',
    description:
      'Create a new DAG (development task graph). PM/PMO decomposes a human requirement ' +
      'into a structured task graph. DAG starts in "draft" status — add tasks with dag_add_task, ' +
      'then activate with dag_activate.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'DAG title. Max 128 chars.' },
        description: { type: 'string', description: 'Human original requirement description.' },
        workspace: { type: 'string', description: 'Workspace name. Default: current workspace.' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'dag_add_task',
    description:
      'Add a task node to a draft DAG. System validates executor!=reviewer, no cycles, ' +
      'dependencies exist. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID from dag_create.' },
        title: { type: 'string', description: 'Task title. Max 128 chars.' },
        description: { type: 'string', description: 'Task description.' },
        executor_uid: { type: 'string', description: 'Agent UID who will execute this task.' },
        reviewer_uid: { type: 'string', description: 'Agent UID who will review this task. Must differ from executor_uid.' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must be approved before this task activates.' },
        acceptance_criteria: { type: 'string', description: 'Measurable acceptance criteria for the reviewer to check.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority. Default: normal.' },
      },
      required: ['dag_id', 'title', 'executor_uid', 'reviewer_uid', 'acceptance_criteria'],
    },
  },
  {
    name: 'dag_activate',
    description:
      'Activate a draft DAG. Auto-activates all tasks with zero unresolved dependencies. ' +
      'DAG status changes from draft to active. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID to activate.' },
      },
      required: ['dag_id'],
    },
  },
  {
    name: 'dag_status',
    description:
      'Query full DAG status including all task nodes, their statuses, and dependency graph.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID to query.' },
      },
      required: ['dag_id'],
    },
  },
  {
    name: 'dag_cancel',
    description:
      'Cancel an entire DAG. All non-approved tasks are marked cancelled. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID to cancel.' },
        reason: { type: 'string', description: 'Reason for cancellation.' },
      },
      required: ['dag_id', 'reason'],
    },
  },

  // ── Sprint 31: Task Submission / Review ──────────────────────────────

  {
    name: 'dag_submit_task',
    description:
      'Submit a completed task for review. ONLY the task executor can call this. ' +
      'Status: active → submitted. Requires non-empty content describing what was done.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to submit.' },
        content: { type: 'string', description: 'Description of completed work (markdown).' },
        attachments: { type: 'array', items: { type: 'object' }, description: 'Optional file references [{type, path, summary}].' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'dag_approve_task',
    description:
      'Approve a submitted task. ONLY the task reviewer can call this. ' +
      'Status: submitted → approved. Auto-unlocks downstream dependent tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to approve.' },
        comment: { type: 'string', description: 'Optional approval comment.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'dag_reject_task',
    description:
      'Reject a submitted task with mandatory feedback. ONLY the task reviewer can call this. ' +
      'Status: submitted → active (retry_count++). After max_retries (default 3), auto-escalates to PM.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to reject.' },
        comment: { type: 'string', description: 'Required: what needs to be fixed (actionable feedback for executor).' },
      },
      required: ['task_id', 'comment'],
    },
  },
  {
    name: 'dag_my_tasks',
    description:
      'List all DAG tasks where the caller is either executor or reviewer.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'dag_reassign_task',
    description:
      'Reassign executor or reviewer for a task. PM/PMO only. ' +
      'Re-validates executor!=reviewer after reassignment.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to reassign.' },
        new_executor_uid: { type: 'string', description: 'New executor agent UID.' },
        new_reviewer_uid: { type: 'string', description: 'New reviewer agent UID.' },
      },
      required: ['task_id'],
    },
  },

  // ── Sprint 31: Sleep/Wake Management ─────────────────────────────────

  {
    name: 'dag_sleep_agent',
    description:
      'Put an agent to sleep by injecting /compact into their PTY. ' +
      'PM can sleep workers; PMO can sleep PM. Auto-wakes after wake_after_minutes (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID to put to sleep.' },
        wake_after_minutes: { type: 'number', description: 'Minutes before auto-wake. Default: 5.' },
      },
      required: ['target_uid'],
    },
  },
  {
    name: 'dag_wake_agent',
    description:
      'Immediately wake a sleeping agent by injecting check_inbox into their PTY.',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID to wake.' },
      },
      required: ['target_uid'],
    },
  },

  // ── Sprint 31: PMO Operations ────────────────────────────────────────

  {
    name: 'pmo_poll',
    description:
      'PMO-only: full team health check. If all workers idle, ask PM for progress. ' +
      'If PM unresponsive (2 consecutive failures), execute PM recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace to poll. Default: current.' },
      },
      required: [],
    },
  },
  {
    name: 'dag_list',
    description:
      'List all DAGs in the workspace with summary counts (total/pending/active/submitted/approved).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name.' },
      },
      required: [],
    },
  },

];

module.exports = { TOOLS };
