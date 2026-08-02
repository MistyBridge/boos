// Goal persistence layer — Sprint 37.
//
// Goals are user-submitted high-level requirements that PM±PMO decompose
// into DAGs. One Goal → N disconnected DAGs (if they share deps, they
// should be merged into one DAG at decomposition time).
//
// Storage: ~/.boos/goals.json (active goals)
// Archive:  ~/.boos/goals-archive.jsonl (append-only, completed/rejected)
//
// All writes serialize through withFileLock — same pattern as dagStore.

'use strict';

const path = require('path');
const fs = require('fs');
const { withFileLock, atomicWriteJson } = require('../atomicJson');
const store = require('./store');

// ── paths ───────────────────────────────────────────────────────────────

const DATA_DIR = process.env.BOOS_HOME
  ? path.join(process.env.BOOS_HOME)
  : path.join(require('os').homedir(), '.boos');

const GOALS_PATH = path.join(DATA_DIR, 'goals.json');
const ARCHIVE_PATH = path.join(DATA_DIR, 'goals-archive.jsonl');

// ── helpers ──────────────────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

function genGoalId() {
  return 'goal_' + require('node:crypto').randomUUID().slice(0, 8);
}

// ── load / save ──────────────────────────────────────────────────────────

async function _load() {
  try {
    const raw = await fs.promises.readFile(GOALS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function _save(data) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await atomicWriteJson(GOALS_PATH, data);
}

// ── resolve PM / PMO (soft-coded, never hardcoded UIDs) ─────────────────

/**
 * Find the supervisor (PM) for a workspace/project.
 * Supervisor = agent with role 'supervisor' in the workspace.
 */
function resolveProjectPM(workspace) {
  const agents = store.listAgentsInWorkspace ? store.listAgentsInWorkspace(workspace) : [];
  if (!agents || agents.length === 0) {
    // Fallback: scan agent-bus DB directly.
    const db = store._syncLoad ? store._syncLoad() : null;
    if (db && db.agents) {
      for (const [uid, a] of Object.entries(db.agents)) {
        if (a.role === 'supervisor' && (a.workspace === workspace || a.workspace === '*')) {
          return uid;
        }
      }
    }
    return null;
  }
  const pm = agents.find((a) => a.role === 'supervisor');
  return pm ? pm.uid : null;
}

/**
 * Find the PMO for a workspace/project.
 * PMO = agent with role 'pmo'. Returns null if none (PM 兼任).
 */
function resolveProjectPMO(workspace) {
  const agents = store.listAgentsInWorkspace ? store.listAgentsInWorkspace(workspace) : [];
  if (!agents || agents.length === 0) {
    const db = store._syncLoad ? store._syncLoad() : null;
    if (db && db.agents) {
      for (const [uid, a] of Object.entries(db.agents)) {
        if (a.role === 'pmo' && (a.workspace === workspace || a.workspace === '*')) {
          return uid;
        }
      }
    }
    return null;
  }
  const pmo = agents.find((a) => a.role === 'pmo');
  return pmo ? pmo.uid : null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────

async function createGoal({ title, description, workspace, project, creatorUid }) {
  if (!title || typeof title !== 'string') {
    return { ok: false, error: 'title is required (max 256 chars)' };
  }
  if (!workspace) {
    return { ok: false, error: 'workspace is required' };
  }

  const goalId = genGoalId();
  const pmUid = resolveProjectPM(workspace);
  const pmoUid = resolveProjectPMO(workspace);

  const goal = {
    goal_id: goalId,
    title: title.slice(0, 256),
    description: (description || '').slice(0, 4096),
    workspace,
    project: project || null,
    creator_uid: creatorUid || 'ROOT_UID',
    assigned_pm_uid: pmUid,
    assigned_pmo_uid: pmoUid,
    status: 'submitted',
    dag_ids: [],
    feedback_thread: [],
    created_at: _now(),
    updated_at: _now(),
    archived_at: null,
  };

  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    db[goalId] = goal;
    await _save(db);
    return { ok: true, goal };
  });
}

function getGoal(goalId) {
  try {
    const raw = fs.readFileSync(GOALS_PATH, 'utf-8');
    const db = JSON.parse(raw);
    return db[goalId] || null;
  } catch {
    return null;
  }
}

async function listGoals(workspace, project, status) {
  let db;
  try { db = await _load(); } catch { return []; }

  let goals = Object.values(db);
  if (workspace) goals = goals.filter((g) => g.workspace === workspace);
  if (project) goals = goals.filter((g) => g.project === project);
  if (status) goals = goals.filter((g) => g.status === status);
  goals.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return goals;
}

async function updateGoal(goalId, updates) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);

    const allowed = ['title', 'description', 'status', 'assigned_pm_uid', 'assigned_pmo_uid'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        goal[key] = typeof updates[key] === 'string' ? updates[key].slice(0, key === 'description' ? 4096 : 256) : updates[key];
      }
    }
    goal.updated_at = _now();
    await _save(db);
    return { ok: true, goal };
  });
}

async function addDagToGoal(goalId, dagId) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);
    if (!goal.dag_ids.includes(dagId)) {
      goal.dag_ids.push(dagId);
      goal.updated_at = _now();
      // Auto-transition: submitted → decomposing on first DAG.
      if (goal.status === 'submitted') {
        goal.status = 'decomposing';
      }
    }
    await _save(db);
    return { ok: true, goal };
  });
}

// ── status transitions ───────────────────────────────────────────────────

async function startGoal(goalId) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);

    const validFrom = new Set(['approved', 'paused', 'review']);
    if (!validFrom.has(goal.status)) {
      throw new Error(`cannot start goal in status "${goal.status}" — must be approved/paused/review`);
    }

    goal.status = 'active';
    goal.updated_at = _now();

    // Activate all associated DAGs.
    const dagStore = require('./dagStore');
    const activationResults = [];
    for (const dagId of goal.dag_ids) {
      try {
        const dag = dagStore.getDag(dagId);
        if (dag && (dag.status === 'ready' || dag.status === 'paused')) {
          await dagStore.activateDag(dagId);
          activationResults.push({ dag_id: dagId, activated: true });
        } else {
          activationResults.push({ dag_id: dagId, activated: false, status: dag ? dag.status : 'not found' });
        }
      } catch (e) {
        activationResults.push({ dag_id: dagId, activated: false, error: e.message });
      }
    }

    await _save(db);
    return { ok: true, goal, activation_results: activationResults };
  });
}

async function pauseGoal(goalId) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);

    if (goal.status !== 'active') {
      throw new Error(`cannot pause goal in status "${goal.status}" — must be active`);
    }

    goal.status = 'paused';
    goal.updated_at = _now();

    // Pause all associated DAGs (stops new task dispatch, executing tasks continue).
    const storeMod = require('./store');
    const { atomicWriteJson: atomicWrite } = require('../atomicJson');
    const pauseResults = [];
    for (const dagId of goal.dag_ids) {
      try {
        const dagStore = require('./dagStore');
        const dag = dagStore.getDag(dagId);
        if (dag && dag.status === 'active') {
          // Update DAG status via direct lock (avoids adding updateDagStatus to dagStore).
          await withFileLock(storeMod.DB_PATH, async () => {
            const db = await storeMod._load();
            if (db.dags && db.dags[dagId]) {
              db.dags[dagId].status = 'paused';
              await atomicWrite(storeMod.DB_PATH, db);
            }
          });
          pauseResults.push({ dag_id: dagId, paused: true });
        } else {
          pauseResults.push({ dag_id: dagId, paused: false, status: dag ? dag.status : 'not found' });
        }
      } catch (e) {
        pauseResults.push({ dag_id: dagId, paused: false, error: e.message });
      }
    }

    await _save(db);
    return { ok: true, goal, pause_results: pauseResults };
  });
}

async function archiveGoal(goalId) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);

    if (goal.status !== 'completed' && goal.status !== 'rejected') {
      throw new Error(`cannot archive goal in status "${goal.status}" — must be completed or rejected`);
    }

    goal.archived_at = _now();
    goal.status = goal.status === 'completed' ? 'completed' : 'rejected';

    // Append to archive JSONL.
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.appendFile(ARCHIVE_PATH, JSON.stringify(goal) + '\n', 'utf-8');

    // Remove from active goals.
    delete db[goalId];
    await _save(db);

    return { ok: true, archived: true, goal_id: goalId };
  });
}

// ── feedback ─────────────────────────────────────────────────────────────

async function addFeedback(goalId, { fromUid, fromName, content, type, targetTaskId }) {
  return withFileLock(GOALS_PATH, async () => {
    const db = await _load();
    const goal = db[goalId];
    if (!goal) throw new Error('goal not found: ' + goalId);

    const entry = {
      from_uid: fromUid,
      from_name: fromName || 'Unknown',
      content: (content || '').slice(0, 4096),
      timestamp: _now(),
      type: type || 'overall',
      target_task_id: targetTaskId || null,
    };

    goal.feedback_thread.push(entry);
    goal.updated_at = _now();
    await _save(db);
    return { ok: true, entry };
  });
}

module.exports = {
  createGoal, getGoal, listGoals, updateGoal, addDagToGoal,
  startGoal, pauseGoal, archiveGoal, addFeedback,
  resolveProjectPM, resolveProjectPMO,
  genGoalId,
  GOALS_PATH, ARCHIVE_PATH,
};
