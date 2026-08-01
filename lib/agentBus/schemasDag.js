// DAG Task System MCP tool schemas — Sprint 31.
//
// Extracted from schemas.js (Sprint 31 refactor — ≤500 lines).
// Merged into TOOLS array by schemas.js.

'use strict';

const DAG_TOOLS = [
  {
    name: 'dag_create',
    description: 'Create a new DAG (development task graph). PM/PMO decomposes a human requirement into a structured task graph. DAG starts in "draft" status — add tasks with dag_add_task, then activate with dag_activate.',
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
    description: 'Add a task node to a draft DAG. System validates executor!=reviewer, no cycles, dependencies exist. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID from dag_create.' },
        title: { type: 'string', description: 'Task title. Max 128 chars.' },
        description: { type: 'string', description: 'Task description.' },
        executor_uid: { type: 'string', description: 'Agent UID (cliSessionId / Claude --resume UUID) who will execute this task.' },
        reviewer_uid: { type: 'string', description: 'Agent UID (cliSessionId / Claude --resume UUID) who will review this task. Must differ from executor_uid.' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must be approved before this task activates.' },
        acceptance_criteria: { type: 'string', description: 'Measurable acceptance criteria for the reviewer to check.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority. Default: normal.' },
      },
      required: ['dag_id', 'title', 'executor_uid', 'reviewer_uid', 'acceptance_criteria'],
    },
  },
  {
    name: 'dag_activate',
    description: 'Activate a draft DAG. Auto-activates all tasks with zero unresolved dependencies. DAG status changes from draft to active. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: { dag_id: { type: 'string', description: 'DAG ID to activate.' } },
      required: ['dag_id'],
    },
  },
  {
    name: 'dag_status',
    description: 'Query full DAG status including all task nodes, their statuses, and dependency graph.',
    inputSchema: {
      type: 'object',
      properties: { dag_id: { type: 'string', description: 'DAG ID to query.' } },
      required: ['dag_id'],
    },
  },
  {
    name: 'dag_cancel',
    description: 'Cancel an entire DAG. All non-approved tasks are marked cancelled. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'DAG ID to cancel.' },
        reason: { type: 'string', description: 'Reason for cancellation.' },
      },
      required: ['dag_id', 'reason'],
    },
  },
  {
    name: 'dag_submit_task',
    description: 'Submit a completed task for review. ONLY the task executor can call this. Status: active → submitted. Requires non-empty content describing what was done.',
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
    description: 'Approve a submitted task. ONLY the task reviewer can call this. Status: submitted → approved. Auto-unlocks downstream dependent tasks.',
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
    description: 'Reject a submitted task with mandatory feedback. ONLY the task reviewer can call this. Status: submitted → active (retry_count++). After max_retries (default 3), auto-escalates to PM.',
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
    description: 'List all DAG tasks where the caller is either executor or reviewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dag_reassign_task',
    description: 'Reassign executor or reviewer for a task. PM/PMO only. Re-validates executor!=reviewer after reassignment.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to reassign.' },
        new_executor_uid: { type: 'string', description: 'New executor agent UID (cliSessionId / Claude --resume UUID).' },
        new_reviewer_uid: { type: 'string', description: 'New reviewer agent UID (cliSessionId / Claude --resume UUID).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'dag_sleep_agent',
    description: 'Put an agent to sleep by injecting /compact into their PTY. PM can sleep workers; PMO can sleep PM. Auto-wakes after wake_after_minutes (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: { type: 'string', description: 'Agent UID (cliSessionId / Claude --resume UUID) to put to sleep.' },
        wake_after_minutes: { type: 'number', description: 'Minutes before auto-wake. Default: 5.' },
      },
      required: ['target_uid'],
    },
  },
  {
    name: 'dag_wake_agent',
    description: 'Wake a sleeping/idle agent by injecting check_inbox into their PTY. Any registered agent can wake another in the same workspace. No PM/PMO role required.',
    inputSchema: {
      type: 'object',
      properties: { target_uid: { type: 'string', description: 'Agent UID (cliSessionId / Claude --resume UUID) to wake.' } },
      required: ['target_uid'],
    },
  },
  {
    name: 'dag_list',
    description: 'List all DAGs in the workspace with summary counts (total/pending/active/submitted/approved).',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name.' } },
      required: [],
    },
  },
];

module.exports = { DAG_TOOLS };
