// Sprint 33: Data migration — agent_xxx UIDs → BOOS session IDs.
//
// Usage: node scripts/migrate-to-session-id.js [--dry-run]
//
// Scans the agent-bus store for agents still using legacy agent_xxx UIDs,
// resolves their BOOS session IDs via identity cards, and migrates them.
// Also updates task and DAG task UID references.
//
// Safe to run multiple times — already-migrated agents are skipped.

'use strict';

const path = require('node:path');
const { atomicWriteJson, withFileLock } = require('../lib/atomicJson');

// Resolve store path consistently with storeCore.js.
const DATA_DIR = require('../lib/config').DATA_DIR;
const DB_PATH = path.join(DATA_DIR, 'agent-bus.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ── helpers ────────────────────────────────────────────────────────────────

function loadDb() {
  try {
    const fs = require('node:fs');
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { agents: {}, identities: {}, tasks: [], dag_tasks: {} };
    throw e;
  }
}

async function saveDb(db) {
  if (DRY_RUN) {
    console.log('[dry-run] would write', Object.keys(db.agents).length, 'agents');
    return;
  }
  await atomicWriteJson(DB_PATH, db);
}

function isLegacyUid(uid) {
  return uid && uid.startsWith('agent_');
}

// ── main migration ─────────────────────────────────────────────────────────

async function migrate() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== MIGRATION ===');
  console.log('Store:', DB_PATH);
  console.log('');

  const db = loadDb();
  const agents = db.agents || {};
  const identities = db.identities || {};
  const tasks = db.tasks || [];
  const dagTasks = db.dag_tasks || {};

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const mappings = new Map(); // oldUid → newUid

  // ── Phase 1: migrate agent records ──────────────────────────────────
  console.log('Phase 1: Agent records');
  console.log('─'.repeat(60));

  for (const [uid, agent] of Object.entries(agents)) {
    if (!isLegacyUid(uid)) {
      skipped++;
      continue; // already session ID (or ROOT/special)
    }

    // Resolve BOOS session ID.
    const identity = identities[uid];
    const boosSessionId = identity?.boos_session_id;

    if (!boosSessionId || boosSessionId === '__pending__') {
      console.log('  SKIP', uid, '(' + agent.name + ') — no boos_session_id');
      skipped++;
      continue;
    }

    if (!boosSessionId.startsWith('sess-')) {
      console.log('  SKIP', uid, '(' + agent.name + ') — boos_session_id is not sess-*:', boosSessionId);
      skipped++;
      continue;
    }

    // Check target doesn't already exist.
    if (agents[boosSessionId] && agents[boosSessionId] !== agent) {
      console.log('  CONFLICT', uid, '→', boosSessionId, '— target already exists');
      errors++;
      continue;
    }

    console.log('  MIGRATE', uid, '→', boosSessionId, '(' + agent.name + ')');
    agents[boosSessionId] = { ...agent, uid: boosSessionId };
    delete agents[uid];
    mappings.set(uid, boosSessionId);

    // Update identity card key.
    if (identities[uid]) {
      identities[boosSessionId] = { ...identities[uid], agent_uid: boosSessionId };
      delete identities[uid];
    }

    migrated++;
  }

  // ── Phase 2: update task references ─────────────────────────────────
  console.log('');
  console.log('Phase 2: Task references');
  console.log('─'.repeat(60));

  let taskUpdates = 0;
  // tasks is keyed by task_id (object), not an array.
  const taskEntries = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  for (const task of taskEntries) {
    if (task.sender_uid && mappings.has(task.sender_uid)) {
      task.sender_uid = mappings.get(task.sender_uid);
      taskUpdates++;
    }
    if (task.receiver_uid && mappings.has(task.receiver_uid)) {
      task.receiver_uid = mappings.get(task.receiver_uid);
      taskUpdates++;
    }
  }
  console.log('  Updated', taskUpdates, 'task UID references');

  // ── Phase 3: update DAG task references ─────────────────────────────
  console.log('');
  console.log('Phase 3: DAG task references');
  console.log('─'.repeat(60));

  let dagUpdates = 0;
  for (const [taskId, dt] of Object.entries(dagTasks)) {
    if (dt.executor_uid && mappings.has(dt.executor_uid)) {
      dt.executor_uid = mappings.get(dt.executor_uid);
      dagUpdates++;
    }
    if (dt.reviewer_uid && mappings.has(dt.reviewer_uid)) {
      dt.reviewer_uid = mappings.get(dt.reviewer_uid);
      dagUpdates++;
    }
    if (dt.assigned_uid && mappings.has(dt.assigned_uid)) {
      dt.assigned_uid = mappings.get(dt.assigned_uid);
      dagUpdates++;
    }
  }
  console.log('  Updated', dagUpdates, 'DAG UID references');

  // ── Phase 4: persist ────────────────────────────────────────────────
  console.log('');
  console.log('Phase 4: Persist');
  console.log('─'.repeat(60));

  db.agents = agents;
  db.identities = identities;
  db.tasks = tasks;
  db.dag_tasks = dagTasks;

  await saveDb(db);

  // ── summary ─────────────────────────────────────────────────────────
  console.log('');
  console.log('=== SUMMARY ===');
  console.log('  Migrated:', migrated, 'agents');
  console.log('  Skipped:', skipped);
  console.log('  Errors:', errors);
  console.log('  Task refs updated:', taskUpdates);
  console.log('  DAG refs updated:', dagUpdates);
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — no changes written. Remove --dry-run to apply.');
  } else {
    console.log('Migration complete. Restart BOOS for changes to take effect.');
  }

  return { migrated, skipped, errors, taskUpdates, dagUpdates };
}

// ── run ────────────────────────────────────────────────────────────────────

migrate().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
