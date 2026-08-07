// JSON-file persistence layer for agent-bus (embedded in BOOS).
//
// Single data file: ~/.boos/agent-bus.json
// All writes serialize through withFileLock — no lost updates.
// Reads are lock-free: atomicWriteJson guarantees complete files.
//
// Split across 6 modules (Sprint 41 Phase 3):
//   storeCore.js     — _load / _syncLoad / DB_PATH (shared, no circular deps)
//   store.js         — facade (this file, < 200 lines)
//   storeAgents.js   — agent CRUD + sessions + PM identity + heartbeat
//   storeTasks.js    — task CRUD + queries + archival (inboxStore backend)
//   storeIdentity.js — identity cards + session binding + bootstrap
//   inboxStore.js    — per-agent inbox file I/O (low-level)

'use strict';

const { _load, _syncLoad, DB_PATH, DATA_DIR } = require('./storeCore');
const storeIdentity = require('./storeIdentity');
const storeAgents = require('./storeAgents');
const storeTasks = require('./storeTasks');
const inboxStore = require('./inboxStore');
const errReport = require("../errorReport");

function getDb() { return { type: 'json-file', path: DB_PATH }; }
function closeDb() { /* no-op — JSON store has no persistent connection */ }

module.exports = {
  // DB lifecycle
  getDb, closeDb, DB_PATH, DATA_DIR,

  // Agents (storeAgents)
  findAgentByNameWs: storeAgents.findAgentByNameWs,
  getAgent: storeAgents.getAgent,
  insertAgent: storeAgents.insertAgent,
  touchAgent: storeAgents.touchAgent,
  deleteAgent: storeAgents.deleteAgent,
  migrateAgentUid: storeAgents.migrateAgentUid,
  listAgentsInWorkspace: storeAgents.listAgentsInWorkspace,
  listAllAgentsInWorkspace: storeAgents.listAllAgentsInWorkspace,
  listAllAgents: storeAgents.listAllAgents,
  countStaleAgents: storeAgents.countStaleAgents,
  genTaskId: storeAgents.genTaskId,

  // Sessions (storeAgents)
  bindSession: storeAgents.bindSession,
  unbindSession: storeAgents.unbindSession,
  getSessionAgentUid: storeAgents.getSessionAgentUid,
  getSessionByAgentUid: storeAgents.getSessionByAgentUid,
  countAgentSessions: storeAgents.countAgentSessions,

  // PM identity (storeAgents)
  setAgentProject: storeAgents.setAgentProject,
  setAgentPM: storeAgents.setAgentPM,
  isPMOf: storeAgents.isPMOf,

  // Heartbeat (storeAgents)
  touchAgentHeartbeat: storeAgents.touchAgentHeartbeat,
  setAgentUnresponsive: storeAgents.setAgentUnresponsive,

  // Tasks — unified inboxStore backend (Sprint 39, moved to storeTasks Sprint 41)
  getTask: storeTasks.getTask,
  getTaskAsync: storeTasks.getTaskAsync,
  listActiveTasks: storeTasks.listActiveTasks,
  countPendingTasks: storeTasks.countPendingTasks,
  listMyTasks: storeTasks.listMyTasks,
  insertTask: storeTasks.insertTask,
  getPendingTask: storeTasks.getPendingTask,
  listPendingTasks: storeTasks.listPendingTasks,
  listAllPendingQueues: storeTasks.listAllPendingQueues,
  getPendingTaskAsync: storeTasks.getPendingTaskAsync,
  listPendingTasksAsync: storeTasks.listPendingTasksAsync,
  claimPendingTaskAsync: storeTasks.claimPendingTaskAsync,
  updateTaskStatus: storeTasks.updateTaskStatus,
  cancelTaskAtomic: storeTasks.cancelTaskAtomic,
  interruptTaskAtomic: storeTasks.interruptTaskAtomic,
  setTaskWorkflowMeta: storeTasks.setTaskWorkflowMeta,
  incrementTaskRetryCount: storeTasks.incrementTaskRetryCount,
  findTask: storeTasks.findTask,
  listAllTasksInWorkspace: storeTasks.listAllTasksInWorkspace,
  pruneOldTasks: storeTasks.pruneOldTasks,

  // Identity (from storeIdentity)
  ROOT_UID: storeIdentity.ROOT_UID,
  isRootAgent: storeIdentity.isRootAgent,
  writeIdentity: storeIdentity.writeIdentity,
  rebuildAllIndices: storeIdentity.rebuildAllIndices,
  upsertIdentity: storeIdentity.upsertIdentity,
  linkIdentityToSession: storeIdentity.linkIdentityToSession,
  onSessionExited: storeIdentity.onSessionExited,
  bindMcpSession: storeIdentity.bindMcpSession,
  unbindMcpSession: storeIdentity.unbindMcpSession,
  getIdentity: storeIdentity.getIdentity,
  getAgentUidByMcpSession: storeIdentity.getAgentUidByMcpSession,
  autoResolveIdentity: storeIdentity.autoResolveIdentity,
  bootstrapIdentities: storeIdentity.bootstrapIdentities,
  dedupeIdentities: storeIdentity.dedupeIdentities,
  setAgentOfflineHandler: storeIdentity.setAgentOfflineHandler,
  getIdentityByBoosSession: storeIdentity.getIdentityByBoosSession,
  resolveSessionForAgent: storeIdentity.resolveSessionForAgent,

  // Internal (for dagStore.js withFileLock pattern: await store._load())
  _load, _syncLoad,

  // Inbox store (for migration + direct access)
  inboxStore,
};
