// InboxStore — per-agent exclusive inbox files.
//
// Each agent gets their own inbox file and archive.  Only pending and
// in_progress tasks live in the inbox; completed/cancelled tasks are
// immediately moved to the append-only archive.
//
// File layout:
//   ~/.boos/agent-bus/
//     inbox/<uid>.json      { pending: [...], in_progress: [...] }
//     archive/<uid>.jsonl    append-only line-delimited JSON
//     registry.json          agents, sessions, identities
//     dags.json              DAG definitions + tasks
//
// Benefits:
//   - check_inbox only reads ONE small file (the agent's own inbox)
//   - No cross-agent file lock contention
//   - Archive is append-only → never re-read for normal operations
//   - Old approach: 1.16 MB shared file read/write on every operation
//     New approach: ~2 KB per-agent file, archive never touched

'use strict';

const path = require('path');
const fs = require('fs/promises');
const { atomicWriteJson } = require('../atomicJson');
const { DATA_DIR } = require('../config');

const INBOX_DIR = path.join(DATA_DIR, 'agent-bus', 'inbox');
const ARCHIVE_DIR = path.join(DATA_DIR, 'agent-bus', 'archive');

// ── ensure directories ──────────────────────────────────────────────────

async function ensureDirs() {
  await fs.mkdir(INBOX_DIR, { recursive: true });
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
}

// ── path helpers ────────────────────────────────────────────────────────

function inboxPath(uid) { return path.join(INBOX_DIR, `${uid}.json`); }
function archivePath(uid) { return path.join(ARCHIVE_DIR, `${uid}.jsonl`); }

// ── read/write inbox ────────────────────────────────────────────────────

const EMPTY_INBOX = { pending: [], in_progress: [] };

async function loadInbox(uid) {
  const p = inboxPath(uid);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { pending: [], in_progress: [] };
    throw e;
  }
}

function loadInboxSync(uid) {
  const p = inboxPath(uid);
  try {
    const raw = require('fs').readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { pending: [], in_progress: [] };
    throw e;
  }
}

async function saveInbox(uid, inbox) {
  const p = inboxPath(uid);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await atomicWriteJson(p, inbox);
}

// ── archive (append-only) ──────────────────────────────────────────────

async function archiveTask(uid, task) {
  const p = archivePath(uid);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const line = JSON.stringify(task) + '\n';
  await fs.appendFile(p, line, 'utf-8');
}

// ── task operations ─────────────────────────────────────────────────────

// Add a task to the receiver's pending queue.
async function addPending(receiverUid, task) {
  await ensureDirs();
  const inbox = await loadInbox(receiverUid);
  inbox.pending.push(task);
  await saveInbox(receiverUid, inbox);
}

// Claim the highest-priority pending task for an agent.
// Returns the claimed task (moved from pending → in_progress), or null.
async function claimPending(uid) {
  await ensureDirs();
  const inbox = await loadInbox(uid);
  if (inbox.pending.length === 0) return null;

  // Sort by priority (high first) then by created_at (oldest first).
  const PRIO = { high: 0, normal: 1, low: 2 };
  inbox.pending.sort((a, b) => {
    const pa = PRIO[a.priority] ?? 1;
    const pb = PRIO[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return (a.created_at || '').localeCompare(b.created_at || '');
  });

  const task = inbox.pending.shift();
  task.status = 'in_progress';
  task.claimed_at = new Date().toISOString();
  inbox.in_progress.push(task);
  await saveInbox(uid, inbox);
  return task;
}

// Complete (or cancel/interrupt) an in_progress task.
// Moves it from in_progress → archive, returns { ok, task }.
async function completeTask(uid, taskId, status, result) {
  await ensureDirs();
  const inbox = await loadInbox(uid);

  // Find in in_progress first, then pending (for the respond_task fix).
  let idx = inbox.in_progress.findIndex((t) => t.task_id === taskId);
  let from = 'in_progress';
  if (idx === -1) {
    idx = inbox.pending.findIndex((t) => t.task_id === taskId);
    from = 'pending';
  }
  if (idx === -1) return { ok: false, error: 'task not found in inbox' };

  const arr = from === 'in_progress' ? inbox.in_progress : inbox.pending;
  const [task] = arr.splice(idx, 1);
  task.status = status;
  task.completed_at = new Date().toISOString();
  if (result) task.result = typeof result === 'string' ? result.slice(0, 8192) : String(result).slice(0, 8192);

  // Archive FIRST — if this fails, the task is still in the inbox (not yet saved).
  // If we saved inbox first and archive fails, the task is lost.
  await archiveTask(uid, task);
  await saveInbox(uid, inbox);

  // Verify: re-read to confirm status was persisted.
  const verify = await loadInbox(uid);
  const stillThere = verify.pending.find((t) => t.task_id === taskId)
                  || verify.in_progress.find((t) => t.task_id === taskId);
  if (stillThere) {
    console.warn('[inboxStore] completeTask: task', taskId, 'still in inbox after save — retrying');
    // Force remove from both arrays.
    verify.pending = verify.pending.filter((t) => t.task_id !== taskId);
    verify.in_progress = verify.in_progress.filter((t) => t.task_id !== taskId);
    await saveInbox(uid, verify);
  }

  return { ok: true, task };
}

// Cancel a task (pending or in_progress).
async function cancelTask(uid, taskId) {
  return completeTask(uid, taskId, 'cancelled', null);
}

// Interrupt a task (in_progress → back to pending, or just cancelled).
async function interruptTask(uid, taskId, recycle = false) {
  if (recycle) {
    await ensureDirs();
    const inbox = await loadInbox(uid);
    const idx = inbox.in_progress.findIndex((t) => t.task_id === taskId);
    if (idx === -1) return { ok: false, error: 'task not found in in_progress' };
    const [task] = inbox.in_progress.splice(idx, 1);
    task.status = 'pending';
    delete task.claimed_at;
    inbox.pending.push(task);
    await saveInbox(uid, inbox);
    return { ok: true, task };
  }
  return completeTask(uid, taskId, 'interrupted', null);
}

// Get a single task (looks in pending + in_progress).
async function getTask(uid, taskId) {
  const inbox = await loadInbox(uid);
  return inbox.pending.find((t) => t.task_id === taskId)
      || inbox.in_progress.find((t) => t.task_id === taskId)
      || null;
}

// Get a single task synchronously.
function getTaskSync(uid, taskId) {
  const inbox = loadInboxSync(uid);
  return inbox.pending.find((t) => t.task_id === taskId)
      || inbox.in_progress.find((t) => t.task_id === taskId)
      || null;
}

// List all tasks (pending + in_progress) for an agent.
async function listTasks(uid) {
  const inbox = await loadInbox(uid);
  return {
    pending: inbox.pending,
    in_progress: inbox.in_progress,
    total: inbox.pending.length + inbox.in_progress.length,
  };
}

// Count pending tasks for an agent (fast — only reads their file).
async function countPending(uid) {
  const inbox = await loadInbox(uid);
  return inbox.pending.length;
}

// Get all tasks for external listing (API, supervisor view).
async function listAllTasks(uid) {
  const inbox = await loadInbox(uid);
  return [...inbox.pending, ...inbox.in_progress];
}

// ── migration: import tasks from old shared agent-bus.json ──────────────

async function importFromLegacy(db) {
  await ensureDirs();
  const tasks = Object.values(db.tasks || {});
  let imported = 0;

  for (const t of tasks) {
    const uid = t.receiver_uid;
    if (!uid) continue;

    if (t.status === 'pending') {
      const task = { ...t };
      delete task.status; // will be set in inbox
      const inbox = await loadInbox(uid);
      if (!inbox.pending.find((x) => x.task_id === task.task_id)) {
        inbox.pending.push(task);
        await saveInbox(uid, inbox);
        imported++;
      }
    } else if (t.status === 'in_progress') {
      const task = { ...t };
      delete task.status;
      const inbox = await loadInbox(uid);
      if (!inbox.in_progress.find((x) => x.task_id === task.task_id)) {
        inbox.in_progress.push(task);
        await saveInbox(uid, inbox);
        imported++;
      }
    } else {
      // Terminal states → archive immediately.
      await archiveTask(uid, t);
      imported++;
    }
  }

  console.log('[inboxStore] migrated', imported, 'tasks from legacy agent-bus.json');
  return imported;
}

module.exports = {
  INBOX_DIR, ARCHIVE_DIR, ensureDirs,
  inboxPath, archivePath,
  loadInbox, loadInboxSync, saveInbox,
  archiveTask,
  addPending, claimPending, completeTask,
  cancelTask, interruptTask,
  getTask, getTaskSync, listTasks, countPending, listAllTasks,
  importFromLegacy,
};
