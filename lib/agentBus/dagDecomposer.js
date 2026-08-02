// DAG Decomposer — batch DAG creation from pre-decomposed task lists.
//
// Sprint 37: Replaces the manual dag_create + N×dag_add_task + dag_activate
// workflow with a single atomic operation. The PM/AI does the decomposition
// reasoning; this module does the validation, resolution, and persistence.
//
// Key features:
//   1. Name→UID resolution for executor/reviewer fields
//   2. Title→ID resolution for intra-DAG dependency references
//   3. Atomic all-or-nothing creation via withFileLock
//   4. Cycle detection across the full task graph
//   5. Optional auto-activation after creation
//   6. Detailed validation report (warnings + errors)

'use strict';

const store = require('./store');
const dagStore = require('./dagStore');
const { withFileLock } = require('./storeCore');
const { atomicWriteJson } = require('../atomicJson');

// ── helpers ──────────────────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

/**
 * Resolve an agent reference (name or UID) to a concrete UID.
 * Returns { uid } or { error }.
 */
function resolveAgent(ref, workspace, db) {
  if (!ref || typeof ref !== 'string') {
    return { error: 'agent reference must be a non-empty string' };
  }

  // Try direct UID lookup first.
  if (db.agents[ref]) {
    const a = db.agents[ref];
    if (a.workspace !== workspace && a.workspace !== '*') {
      return { error: `agent "${ref}" is not in workspace "${workspace}"` };
    }
    return { uid: ref, name: a.name, resolvedBy: 'uid' };
  }

  // Try name lookup within the workspace.
  const key = `${ref}|${workspace}`;
  const uid = db.name_ws_index[key];
  if (uid && db.agents[uid]) {
    return { uid, name: ref, resolvedBy: 'name' };
  }

  // Try fuzzy: scan all agents in workspace for matching name.
  const agents = Object.values(db.agents).filter(
    (a) => a.workspace === workspace || a.workspace === '*'
  );
  const match = agents.find((a) => a.name === ref);
  if (match) {
    return { uid: match.uid, name: match.name, resolvedBy: 'name-fuzzy' };
  }

  const available = agents.map((a) => `${a.name} (${a.uid.slice(-8)})`).join(', ');
  return {
    error: `agent "${ref}" not found in workspace "${workspace}". Available: ${available || '(none)'}`,
  };
}

/**
 * Resolve dependency references within a DAG's task list.
 * Dependencies can reference tasks by their title (within the same batch)
 * or by explicit task ID.
 */
function resolveDependencies(taskDefs, taskIdMap, titleToId) {
  const resolved = [];
  const warnings = [];

  for (const depRef of taskDefs) {
    // Already a task ID.
    if (taskIdMap[depRef]) {
      resolved.push(depRef);
      continue;
    }
    // Resolve by title.
    if (titleToId[depRef]) {
      resolved.push(titleToId[depRef]);
      continue;
    }
    warnings.push(`dependency "${depRef}" could not be resolved — no task with that title or ID in this DAG`);
  }

  return { dependencies: resolved, warnings };
}

/**
 * Build a topological order for task creation.
 * Tasks with no deps come first; dependent tasks follow.
 * Returns sorted task indices or throws on cycle.
 *
 * Uses pre-resolved depMap (task_id → task_id[]) rather than re-matching
 * raw title strings. The depMap was already computed by resolveDependencies()
 * which handles title→ID conversion, so we build the graph directly from
 * resolved task IDs.
 */
function topologicalSort(taskDefs, depMap) {
  const n = taskDefs.length;
  const inDegree = new Array(n).fill(0);
  const adjacency = new Array(n).fill(null).map(() => []);

  // Build reverse index: task_id → index.
  const idToIndex = new Map();
  for (let i = 0; i < n; i++) {
    idToIndex.set(taskDefs[i]._taskId, i);
  }

  // Build graph from resolved depMap.
  for (let i = 0; i < n; i++) {
    const deps = depMap[i] || [];
    for (const depTaskId of deps) {
      const j = idToIndex.get(depTaskId);
      if (j !== undefined && j !== i) {
        adjacency[j].push(i);
        inDegree[i]++;
      }
    }
  }

  const queue = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);
    for (const neighbor of adjacency[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== taskDefs.length) {
    // Find cycle participants.
    const unsorted = new Set();
    for (let i = 0; i < taskDefs.length; i++) {
      if (!sorted.includes(i)) unsorted.add(taskDefs[i].title);
    }
    throw new Error(
      `circular dependency detected among tasks: ${[...unsorted].join(' →← ')}`
    );
  }

  return sorted;
}

// ── main entry point ─────────────────────────────────────────────────────

/**
 * Decompose a high-level goal into a DAG of tasks.
 *
 * @param {object} opts
 * @param {string} opts.title - DAG title (max 128 chars)
 * @param {string} opts.description - Human original requirement description
 * @param {string} opts.workspace - Workspace name
 * @param {string} opts.createdBy - PM UID creating this DAG
 * @param {Array<object>} opts.tasks - Array of task definitions:
 *   { title, description, executor, reviewer, dependencies?, acceptance_criteria, priority? }
 *   executor/reviewer can be agent name OR UID — resolved automatically.
 *   dependencies can reference other tasks by title (within this batch) or explicit task ID.
 * @param {boolean} [opts.autoActivate=true] - Activate DAG after creation
 * @param {object} [opts.metadata] - Optional metadata for the DAG
 * @returns {object} { ok, dag, tasks, summary, resolution_report, warnings }
 */
async function decompose(opts) {
  const {
    title, description, workspace, createdBy, tasks: taskDefs,
    autoActivate = true, metadata = null,
  } = opts;

  // ── validation phase (before lock) ──────────────────────────────────

  if (!title || typeof title !== 'string') {
    return { ok: false, error: 'title is required (max 128 chars)' };
  }
  if (!workspace || !createdBy) {
    return { ok: false, error: 'workspace and createdBy are required' };
  }
  if (!Array.isArray(taskDefs) || taskDefs.length === 0) {
    return { ok: false, error: 'tasks must be a non-empty array of task definitions' };
  }
  if (taskDefs.length > 50) {
    return { ok: false, error: 'too many tasks (max 50 per DAG decomposition)' };
  }

  // Validate each task definition structure.
  const structErrors = [];
  for (let i = 0; i < taskDefs.length; i++) {
    const t = taskDefs[i];
    if (!t.title || typeof t.title !== 'string') {
      structErrors.push(`task[${i}]: title is required`);
    }
    if (!t.description && !t.acceptance_criteria) {
      structErrors.push(`task[${i}] "${t.title || '???'}": description or acceptance_criteria is required`);
    }
    if (!t.executor) {
      structErrors.push(`task[${i}] "${t.title || '???'}": executor is required`);
    }
    if (!t.reviewer) {
      structErrors.push(`task[${i}] "${t.title || '???'}": reviewer is required`);
    }
    if (t.executor && t.reviewer && t.executor === t.reviewer) {
      structErrors.push(`task[${i}] "${t.title}": executor and reviewer must be different agents`);
    }
  }
  if (structErrors.length > 0) {
    return { ok: false, error: 'task validation failed', details: structErrors };
  }

  // ── atomic creation phase ───────────────────────────────────────────

  const dagId = dagStore.genDagId();
  const report = { resolutions: [], depWarnings: [], errors: [] };

  try {
    await withFileLock(store.DB_PATH, async () => {
      const db = await store._load();

      // Ensure structures exist.
      if (!db.dags) db.dags = {};
      if (!db.dag_tasks) db.dag_tasks = {};

      // 1. Resolve all agent references.
      const resolvedExecutors = [];
      const resolvedReviewers = [];
      for (let i = 0; i < taskDefs.length; i++) {
        const t = taskDefs[i];
        const execRes = resolveAgent(t.executor, workspace, db);
        const revRes = resolveAgent(t.reviewer, workspace, db);

        if (execRes.error) {
          report.errors.push(`task[${i}] "${t.title}": executor — ${execRes.error}`);
        }
        if (revRes.error) {
          report.errors.push(`task[${i}] "${t.title}": reviewer — ${revRes.error}`);
        }
        resolvedExecutors.push(execRes);
        resolvedReviewers.push(revRes);
      }

      if (report.errors.length > 0) {
        throw new Error('agent resolution failed');
      }

      // Verify executor ≠ reviewer for each task.
      for (let i = 0; i < taskDefs.length; i++) {
        if (resolvedExecutors[i].uid === resolvedReviewers[i].uid) {
          report.errors.push(
            `task[${i}] "${taskDefs[i].title}": executor and reviewer resolved to same agent "${resolvedExecutors[i].name}"`
          );
        }
      }
      if (report.errors.length > 0) {
        throw new Error('executor/reviewer validation failed');
      }

      // 2. Generate task IDs and build lookup maps.
      const taskIdMap = {};   // task_id → true
      const titleToId = {};    // title → task_id
      const taskIds = [];

      for (let i = 0; i < taskDefs.length; i++) {
        const tid = dagStore.genTaskId();
        taskIds.push(tid);
        taskIdMap[tid] = true;
        titleToId[taskDefs[i].title] = tid;
        taskDefs[i]._taskId = tid;
      }

      // 3. Resolve dependencies.
      const depMap = {};
      for (let i = 0; i < taskDefs.length; i++) {
        const t = taskDefs[i];
        if (t.dependencies && t.dependencies.length > 0) {
          const res = resolveDependencies(t.dependencies, taskIdMap, titleToId);
          depMap[i] = res.dependencies;
          if (res.warnings.length > 0) {
            report.depWarnings.push(
              ...res.warnings.map((w) => `task[${i}] "${t.title}": ${w}`)
            );
          }
        } else {
          depMap[i] = [];
        }
      }

      // 4. Topological sort for creation order.
      let creationOrder;
      try {
        creationOrder = topologicalSort(taskDefs, depMap);
      } catch (cycleErr) {
        report.errors.push(cycleErr.message);
        throw new Error('dependency cycle detected');
      }

      // 5. Create the DAG.
      const dag = {
        dag_id: dagId,
        title: title.slice(0, 128),
        description: (description || '').slice(0, 4096),
        requester: 'pm',
        workspace,
        status: 'draft',
        created_by: createdBy,
        created_at: _now(),
        completed_at: null,
        task_count: taskDefs.length,
        approved_count: 0,
        metadata: metadata || null,
        // Structured task ordering for the frontend DAG visualization.
        task_sequence: taskDefs.map((t, i) => ({
          index: i,
          task_id: t._taskId,
          title: t.title,
          deps: depMap[i],
          executor: resolvedExecutors[i].name,
          reviewer: resolvedReviewers[i].name,
        })),
      };

      db.dags[dagId] = dag;

      // 6. Create all task nodes (in topological order).
      const createdTasks = [];
      for (const idx of creationOrder) {
        const t = taskDefs[idx];
        const task = {
          task_id: t._taskId,
          dag_id: dagId,
          title: t.title.slice(0, 128),
          description: (t.description || '').slice(0, 4096),
          executor_uid: resolvedExecutors[idx].uid,
          reviewer_uid: resolvedReviewers[idx].uid,
          dependencies: depMap[idx],
          acceptance_criteria: (t.acceptance_criteria || t.description || '').slice(0, 2048),
          status: 'pending',
          priority: t.priority || 'normal',
          submit_content: null,
          submit_attachments: null,
          review_comment: null,
          review_history: [],
          retry_count: 0,
          max_retries: t.max_retries || 3,
          created_at: _now(),
          activated_at: null,
          submitted_at: null,
          reviewed_at: null,
          completed_at: null,
          // Sprint 37: publisher (task proposer) + PM review questions.
          publisher_uid: t.publisher || createdBy,
          proposal_reason: null,
          proposed_at: null,
          review_questions: (t.review_questions || []).map((q) => ({
            question_id: 'q_' + require('node:crypto').randomUUID().slice(0, 8),
            question: q.question,
            options: q.options || [],
            user_choice: null,
            impact: q.impact || '',
            answered_at: null,
            skipped: false,
          })),
          user_notes: [],
          // Force-modify tracking (Sprint 37).
          force_modified_at: null,
          force_modified_by: null,
          re_notified_to_executor: false,
          // Store resolved names for UI display.
          _executor_name: resolvedExecutors[idx].name,
          _reviewer_name: resolvedReviewers[idx].name,
        };

        db.dag_tasks[t._taskId] = task;
        createdTasks.push(task);

        report.resolutions.push({
          task_title: t.title,
          task_id: t._taskId,
          executor: `${resolvedExecutors[idx].name} (${resolvedExecutors[idx].resolvedBy})`,
          reviewer: `${resolvedReviewers[idx].name} (${resolvedReviewers[idx].resolvedBy})`,
          deps_count: depMap[idx].length,
        });
      }

      // 7. Write everything to disk (draft status, before activation).
      await atomicWriteJson(store.DB_PATH, db);
    });

    // ── activation (outside lock — delegates to dagStore.activateDag) ────
    // Using dagStore.activateDag() rather than manual status setting ensures
    // consistency with the single-task creation path (dag_create → dag_add_task
    // → dag_activate). Both paths now go through the same validation logic.

    let activation = null;
    if (autoActivate) {
      try {
        const activationResult = await dagStore.activateDag(dagId);
        // activateDag returns void on success; enrich the result ourselves.
        const dagAfter = dagStore.getDag(dagId);
        const allTasks = Object.values(dagAfter?.tasks || dagAfter || {})
          .filter((t) => t && typeof t === 'object' && t.dag_id === dagId);
        activation = {
          ready_count: allTasks.filter((t) => t.status === 'active').length,
          blocked_count: allTasks.filter((t) => t.status === 'pending').length,
          total: allTasks.length,
        };
      } catch (activationErr) {
        // Activation failed — DAG stays in draft. Notify PM + return error.
        try {
          const queue = require('./queue');
          await queue.sendTask({
            sender: { uid: 'agent_root', name: 'System', intro: 'DAG activation monitor.' },
            receiver_uid: createdBy,
            content: `DAG "${title}" (${dagId}) activation failed: ${activationErr.message}\n` +
              'DAG is in draft status. Run dag_activate manually or fix issues and re-decompose.',
            priority: 'high',
            metadata: { type: 'dag_activation_error', dag_id: dagId, error: activationErr.message },
          });
        } catch {}
        return {
          ok: true,
          dag_id: dagId,
          dag: dagStore.getDag(dagId),
          summary: dagStore.getDagSummary(dagId),
          task_count: taskDefs.length,
          auto_activated: false,
          activation_error: activationErr.message,
          resolution_report: report.resolutions,
          warnings: report.depWarnings.length > 0 ? report.depWarnings : undefined,
        };
      }
    }

    // ── build result ────────────────────────────────────────────────────

    const dag = dagStore.getDag(dagId);
    const summary = dagStore.getDagSummary(dagId);

    return {
      ok: true,
      dag_id: dagId,
      dag,
      summary,
      task_count: taskDefs.length,
      auto_activated: autoActivate,
      activation,
      resolution_report: report.resolutions,
      warnings: report.depWarnings.length > 0 ? report.depWarnings : undefined,
    };

  } catch (err) {
    // If we created the DAG but failed mid-way, try to clean up.
    if (report.errors.length > 0 || err.message.includes('failed') || err.message.includes('cycle')) {
      return {
        ok: false,
        error: err.message,
        details: report.errors.length > 0 ? report.errors : undefined,
        dep_warnings: report.depWarnings.length > 0 ? report.depWarnings : undefined,
      };
    }
    // Unexpected error — still try to provide useful feedback.
    return {
      ok: false,
      error: err.message,
      details: report.errors,
      phase: 'unexpected',
    };
  }
}

/**
 * Suggest task assignments based on capability matching.
 * Callers can use this to pre-fill executor/reviewer fields before calling decompose().
 *
 * @param {string} workspace - Workspace name
 * @param {Array<{title, required_capabilities}>} taskHints - Tasks with capability requirements
 * @returns {object} { suggestions: [{title, executor_uid, executor_name, reviewer_uid, reviewer_name}] }
 */
function suggestAssignments(workspace, taskHints) {
  const agents = store.listAgentsInWorkspace(workspace);
  if (agents.length === 0) {
    return { ok: false, error: `no agents in workspace "${workspace}"` };
  }

  const suggestions = [];
  const usedAsReviewer = new Set();

  for (const hint of taskHints) {
    const requiredCaps = hint.required_capabilities || [];

    // Find best executor: agent whose capabilities match most required caps.
    let bestExecutor = null;
    let bestScore = -1;

    for (const agent of agents) {
      if (agent.role === 'supervisor') continue; // Don't assign PM as executor.
      const caps = new Set(agent.capabilities || []);
      if (caps.has('general')) {
        // Generalists can do anything but are rated lower for specific skills.
        const score = requiredCaps.length > 0 ? 0.5 : 1;
        if (score > bestScore) { bestScore = score; bestExecutor = agent; }
        continue;
      }
      const score = requiredCaps.filter((c) => caps.has(c)).length;
      if (score > bestScore) {
        bestScore = score;
        bestExecutor = agent;
      }
    }

    if (!bestExecutor) {
      // Fallback to first non-supervisor agent.
      bestExecutor = agents.find((a) => a.role !== 'supervisor') || agents[0];
    }

    // Find reviewer: different agent, not already reviewing too many tasks.
    const candidates = agents.filter(
      (a) => a.uid !== bestExecutor.uid && !usedAsReviewer.has(a.uid)
    );
    // Prefer supervisor as reviewer if available and not executor.
    let reviewer = candidates.find((a) => a.role === 'supervisor');
    if (!reviewer) {
      // Pick the agent with fewest review assignments so far.
      reviewer = candidates[0] || agents.find((a) => a.uid !== bestExecutor.uid);
    }

    if (reviewer) usedAsReviewer.add(reviewer.uid);

    suggestions.push({
      title: hint.title,
      executor_uid: bestExecutor.uid,
      executor_name: bestExecutor.name,
      reviewer_uid: reviewer ? reviewer.uid : null,
      reviewer_name: reviewer ? reviewer.name : null,
    });
  }

  return { ok: true, suggestions };
}

module.exports = { decompose, suggestAssignments };
