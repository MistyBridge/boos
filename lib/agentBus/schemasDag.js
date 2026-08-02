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
  {
    name: 'dag_decompose',
    description: 'Batch-create a full DAG from a pre-decomposed task list. Replaces dag_create + N×dag_add_task + dag_activate in one atomic operation. Resolves agent names→UIDs and task title→ID dependency references automatically. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'DAG title. Max 128 chars.' },
        description: { type: 'string', description: 'Original human goal/requirement description.' },
        workspace: { type: 'string', description: 'Workspace name. Default: current workspace.' },
        tasks: {
          type: 'array',
          description: 'Array of task definitions (max 50). Each task: {title, description, executor, reviewer, dependencies?, acceptance_criteria, priority?, max_retries?}. executor/reviewer can be agent name OR UID. dependencies can reference other tasks by title.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title. Max 128 chars.' },
              description: { type: 'string', description: 'Detailed task description.' },
              executor: { type: 'string', description: 'Agent name or UID who will execute this task.' },
              reviewer: { type: 'string', description: 'Agent name or UID who will review this task. Must differ from executor.' },
              dependencies: { type: 'array', items: { type: 'string' }, description: 'Task titles or IDs that must be approved before this task activates.' },
              acceptance_criteria: { type: 'string', description: 'Measurable acceptance criteria for the reviewer.' },
              priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority. Default: normal.' },
              max_retries: { type: 'number', description: 'Max rejections before escalation. Default: 3.' },
            },
            required: ['title', 'executor', 'reviewer'],
          },
        },
        auto_activate: { type: 'boolean', description: 'Activate DAG immediately after creation. Default: true.' },
      },
      required: ['title', 'description', 'tasks'],
    },
  },
  {
    name: 'dag_suggest_assignments',
    description: 'Suggest executor/reviewer assignments based on capability matching. Given a list of task titles with required capabilities, returns the best agent matches. Use this BEFORE dag_decompose to pre-fill executor/reviewer fields.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name.' },
        tasks: {
          type: 'array',
          description: 'Task hints with capability requirements.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title.' },
              required_capabilities: { type: 'array', items: { type: 'string' }, description: 'Capability tags needed (e.g. ["frontend","react"]).' },
            },
            required: ['title'],
          },
        },
      },
      required: ['workspace', 'tasks'],
    },
  },

  // ── Sprint 37: Goal system ──────────────────────────────────────────

  {
    name: 'goal_create',
    description: 'Create a new high-level Goal. Anyone can propose a Goal — it goes to the PM inbox for decomposition into DAGs. The PM±PMO decompose it, then the user reviews and approves before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Goal title. Max 256 chars.' },
        description: { type: 'string', description: 'Detailed goal description — what should be achieved.' },
        workspace: { type: 'string', description: 'Workspace name. Default: current workspace.' },
        project: { type: 'string', description: 'Project name (e.g. "boos-core").' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'goal_list',
    description: 'List all Goals in a workspace, optionally filtered by project and/or status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name.' },
        project: { type: 'string', description: 'Filter by project.' },
        status: { type: 'string', enum: ['submitted', 'decomposing', 'review', 'approved', 'active', 'paused', 'completed', 'rejected'], description: 'Filter by status.' },
      },
      required: [],
    },
  },
  {
    name: 'goal_status',
    description: 'Get full Goal status including all associated DAGs, their task graphs, and feedback thread.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to query.' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'goal_update',
    description: 'Update Goal metadata (title, description, status, PM/PMO assignment). PM only.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Goal ID.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        status: { type: 'string', enum: ['submitted', 'decomposing', 'review', 'approved', 'active', 'paused', 'completed', 'rejected'], description: 'New status.' },
        assigned_pm_uid: { type: 'string', description: 'Reassign PM.' },
        assigned_pmo_uid: { type: 'string', description: 'Reassign PMO.' },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'goal_archive',
    description: 'Archive a completed or rejected Goal to goals-archive.jsonl. PM only.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to archive.' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'goal_start',
    description: 'Start a Goal — activates all associated DAGs. Only works from approved/paused/review status. ROOT (user) only.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to start.' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'goal_pause',
    description: 'Pause a Goal — pauses all associated DAGs. Stops new task dispatch; executing tasks continue. ROOT (user) only.',
    inputSchema: {
      type: 'object',
      properties: { goal_id: { type: 'string', description: 'Goal ID to pause.' } },
      required: ['goal_id'],
    },
  },

  // ── Sprint 37: Review questions ─────────────────────────────────────

  {
    name: 'dag_add_questions',
    description: 'Add multiple-choice review questions to a DAG task node. PM uses this during the review phase so the user can clarify requirements before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to add questions to.' },
        questions: {
          type: 'array',
          description: 'Array of questions.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text.' },
              options: { type: 'array', items: { type: 'string' }, description: 'Multiple-choice options (A, B, C...).' },
              impact: { type: 'string', description: 'How this decision impacts the implementation (shown to user).' },
            },
            required: ['question'],
          },
        },
      },
      required: ['task_id', 'questions'],
    },
  },
  {
    name: 'dag_answer_question',
    description: 'Answer (or skip) a review question on a DAG task node. ROOT (user) only. Answers go to PM inbox. Use "custom" choice with custom_text for "none of the above".',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID.' },
        question_id: { type: 'string', description: 'Question ID within the task.' },
        choice: { type: 'string', description: 'Selected option, or "custom" for custom answer, or null to skip.' },
        custom_text: { type: 'string', description: 'Custom answer text (only when choice="custom").' },
        skipped: { type: 'boolean', description: 'Set true to skip this question.' },
      },
      required: ['task_id', 'question_id'],
    },
  },

  // ── Sprint 37: Proposal system ──────────────────────────────────────

  {
    name: 'dag_propose_task',
    description: 'Propose a new task node for an existing DAG. Any registered agent can call this. The proposed node blocks its dependent task until PM+PMO approve or reject. Publisher field is set to the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        dag_id: { type: 'string', description: 'Target DAG ID.' },
        title: { type: 'string', description: 'Proposed task title.' },
        description: { type: 'string', description: 'Why this task is needed and what it should achieve.' },
        blocking_task_id: { type: 'string', description: 'Existing task that should be blocked until this proposal is resolved.' },
        suggested_executor: { type: 'string', description: 'Suggested executor (agent name or UID).' },
        suggested_reviewer: { type: 'string', description: 'Suggested reviewer (agent name or UID).' },
        acceptance_criteria: { type: 'string', description: 'How to verify this task is done.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority. Default: normal.' },
      },
      required: ['dag_id', 'title', 'description'],
    },
  },
  {
    name: 'dag_approve_proposal',
    description: 'Approve a proposed task node. Assigns executor/reviewer, sets dependencies, and unblocks the associated task. PM/PMO only. Both PM and PMO must agree — if they disagree, escalate to ROOT.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Proposed task ID to approve.' },
        executor_uid: { type: 'string', description: 'Assigned executor UID.' },
        reviewer_uid: { type: 'string', description: 'Assigned reviewer UID (must differ from executor).' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task depends on.' },
        acceptance_criteria: { type: 'string', description: 'Acceptance criteria for the reviewer.' },
      },
      required: ['task_id', 'executor_uid', 'reviewer_uid'],
    },
  },
  {
    name: 'dag_reject_proposal',
    description: 'Reject a proposed task node. The proposal is marked rejected and the blocked task is unblocked. PM/PMO only.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Proposed task ID to reject.' },
        reason: { type: 'string', description: 'Reason for rejection (required, shown to proposer).' },
      },
      required: ['task_id', 'reason'],
    },
  },

  // ── Sprint 37: Runtime adjustment ───────────────────────────────────

  {
    name: 'dag_rearrange',
    description: 'Rearrange task dependencies within a DAG. PM only. Can add/remove dependency edges. Validates no cycles after rearrangement.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to modify dependencies for.' },
        add_dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to add as dependencies.' },
        remove_dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to remove from dependencies.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'dag_force_modify',
    description: 'Force-modify any field of an executing task. PM only. Old submit_content is archived to review_history before modification. Execution state is reset and executor is re-notified via agent-bus task queue.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to force-modify.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        executor_uid: { type: 'string', description: 'New executor UID.' },
        reviewer_uid: { type: 'string', description: 'New reviewer UID.' },
        acceptance_criteria: { type: 'string', description: 'New acceptance criteria.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'New priority.' },
        reason: { type: 'string', description: 'Reason for the force modification (required, shown to executor).' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'dag_partial_rollback',
    description: 'Partially rollback a DAG — delete ONE task node only. Downstream dependent tasks auto-disconnect and become independent DAGs. PM only. Does NOT cascade-delete subtrees.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Single task ID to remove from the DAG.' },
        reason: { type: 'string', description: 'Reason for the rollback (required).' },
      },
      required: ['task_id', 'reason'],
    },
  },

  // ── Sprint 37: Conflict escalation ──────────────────────────────────

  {
    name: 'dag_escalate_conflict',
    description: 'Escalate a PM+PMO disagreement to the ROOT (human) decision area. Both opinions are included. The human decision binds both parties.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID the conflict is about.' },
        pm_opinion: { type: 'string', description: 'PM\'s opinion/recommendation.' },
        pmo_opinion: { type: 'string', description: 'PMO\'s opinion/recommendation.' },
        summary: { type: 'string', description: 'One-line summary of the conflict for the decision area.' },
      },
      required: ['task_id', 'pm_opinion', 'pmo_opinion', 'summary'],
    },
  },
];

module.exports = { DAG_TOOLS };
