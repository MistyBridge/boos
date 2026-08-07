// Agent + session + PM identity + heartbeat operations.
//
// Extracted from store.js — Sprint 41 Phase 3 refactor.
// All writes serialize through withFileLock (via storeCore).

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const { _load, _syncLoad, _save, DB_PATH, withFileLock } = require('./storeCore');

// ── agent helpers ─────────────────────────────────────────────────────

function findAgentByNameWs(name, workspace) {
  const db = _syncLoad();
  const key = `${name}|${workspace}`;
  const uid = db.name_ws_index[key];
  return uid ? (db.agents[uid] || null) : null;
}

function getAgent(uid) {
  return _syncLoad().agents[uid] || null;
}

async function insertAgent({ uid, name, intro, workspace, role, capabilities, project, pm_of }) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const now = new Date().toISOString();
    const isRoot = role === 'root';
    const agent = {
      uid, name: name.slice(0, 64), intro: (intro || '').slice(0, 256),
      workspace: isRoot ? '*' : workspace, role: role || 'worker',
      capabilities: isRoot ? ['root', 'human_interface'] : (Array.isArray(capabilities) ? capabilities.slice(0, 10) : []),
      project: isRoot ? null : (project || null),
      pm_of: isRoot ? [] : (Array.isArray(pm_of) ? pm_of.slice(0, 20) : []),
      registered_at: now,
      last_seen_at: isRoot ? '9999-12-31T23:59:59.999Z' : now,
    };
    db.agents[uid] = agent;
    if (!isRoot) db.name_ws_index[`${name}|${workspace}`] = uid;
    await _save(db);
    return agent;
  });
}

async function touchAgent(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    if (db.agents[uid]) { db.agents[uid].last_seen_at = new Date().toISOString(); await _save(db); }
  });
}

async function deleteAgent(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    const key = `${agent.name}|${agent.workspace}`;
    delete db.name_ws_index[key];
    for (const [sid, s] of Object.entries(db.sessions)) {
      if (s.agent_uid === uid) delete db.sessions[sid];
    }
    delete db.agents[uid];
    await _save(db);
    return true;
  });
}

async function migrateAgentUid(oldUid, newUid) {
  if (oldUid === newUid) return { ok: true, migrated: false };
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[oldUid];
    if (!agent) return { ok: false, error: 'old uid not found' };
    if (db.agents[newUid]) return { ok: false, error: 'new uid already exists' };
    db.agents[newUid] = { ...agent, uid: newUid };
    delete db.agents[oldUid];
    db.name_ws_index[`${agent.name}|${agent.workspace}`] = newUid;
    for (const [tid, t] of Object.entries(db.tasks || {})) {
      if (t.sender_uid === oldUid) t.sender_uid = newUid;
      if (t.receiver_uid === oldUid) t.receiver_uid = newUid;
    }
    // Sprint 39: also scan all per-agent inbox files (source of truth
    // since Sprint 35) and update sender/receiver UID references.
    const fs = require('fs');
    const errReport = require("../errorReport");
    const ib = require('./inboxStore');
    const inboxDir = ib.INBOX_DIR; // hoisted — used by both try blocks below
    try {
      const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const uid = f.replace('.json', '');
        const inbox = ib.loadInboxSync(uid);
        let changed = false;
        for (const arr of ['pending', 'in_progress']) {
          for (const t of (inbox[arr] || [])) {
            if (t.sender_uid === oldUid) { t.sender_uid = newUid; changed = true; }
            if (t.receiver_uid === oldUid) { t.receiver_uid = newUid; changed = true; }
          }
        }
        if (changed) {
          try {  await ib.saveInbox(uid, inbox);  } catch (e) { errReport.report("storeAgents", "saveInbox", e); }
        }
      }
    } catch (e) { console.warn('[boos] migrateAgentUid inbox scan failed:', e.message); }
    // Sprint 42: rename agent's own inbox file from oldUid to newUid.
    // The scan above updates sender/receiver refs inside files, but the
    // agent's own inbox FILE must be moved so check_inbox(newUid) works.
    try {
      const oldInboxPath = inboxDir + '/' + oldUid + '.json';
      const newInboxPath = inboxDir + '/' + newUid + '.json';
      if (fs.existsSync(oldInboxPath)) {
        if (fs.existsSync(newInboxPath)) {
          // Both exist — merge old into new.
          const oldInbox = ib.loadInboxSync(oldUid);
          const newInbox = ib.loadInboxSync(newUid);
          newInbox.pending = [...newInbox.pending, ...oldInbox.pending];
          newInbox.in_progress = [...newInbox.in_progress, ...oldInbox.in_progress];
          await ib.saveInbox(newUid, newInbox);
          fs.unlinkSync(oldInboxPath);
        } else {
          fs.renameSync(oldInboxPath, newInboxPath);
        }
        console.log('[agent-bus] migrateAgentUid: inbox renamed', oldUid.slice(-12), '→', newUid.slice(-12));
      }
    } catch (e) { console.warn('[boos] migrateAgentUid inbox rename failed:', e.message); }
    for (const [sid, s] of Object.entries(db.sessions || {})) {
      if (s.agent_uid === oldUid) s.agent_uid = newUid;
    }
    await _save(db);
    return { ok: true, migrated: true, oldUid, newUid };
  });
}

function listAgentsInWorkspace(workspace, opts = {}) {
  const db = _syncLoad();
  let agents = Object.values(db.agents).filter((a) => a.workspace === workspace);
  if (opts.project) agents = agents.filter((a) => !a.project || a.project === opts.project);
  return agents
    .map(({ uid, name, intro, workspace, role, capabilities, project, pm_of, last_seen_at }) =>
      ({ uid, name, intro, workspace, role: role || 'worker', capabilities: capabilities || [], project: project || null, pm_of: pm_of || [], last_seen_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listAllAgentsInWorkspace(workspace) {
  const db = _syncLoad();
  return Object.values(db.agents)
    .filter((a) => a.workspace === workspace)
    .map((a) => {
      const sessionCount = Object.values(db.sessions).filter((s) => s.agent_uid === a.uid).length;
      return { uid: a.uid, name: a.name, intro: a.intro, workspace: a.workspace, role: a.role || 'worker', capabilities: a.capabilities || [], project: a.project || null, pm_of: a.pm_of || [], registered_at: a.registered_at, last_seen_at: a.last_seen_at, session_count: sessionCount };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countStaleAgents(cutoff) {
  return Object.values(_syncLoad().agents).filter((a) => a.last_seen_at < cutoff).length;
}

function listAllAgents() {
  return Object.values(_syncLoad().agents).map((a) => ({
    uid: a.uid, name: a.name, intro: a.intro, workspace: a.workspace,
    role: a.role || 'worker', capabilities: a.capabilities || [],
    project: a.project || null, pm_of: a.pm_of || [],
    registered_at: a.registered_at, last_seen_at: a.last_seen_at,
    unresponsive: a.unresponsive || false,
  }));
}

function genTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── session helpers ───────────────────────────────────────────────────

async function bindSession(sessionId, agentUid, workspace) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    db.sessions[sessionId] = { agent_uid: agentUid, workspace, created_at: new Date().toISOString() };
    await _save(db);
  });
}

async function unbindSession(sessionId) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    delete db.sessions[sessionId];
    await _save(db);
  });
}

function getSessionAgentUid(sessionId) {
  const s = _syncLoad().sessions[sessionId];
  return s ? s.agent_uid : null;
}

function getSessionByAgentUid(agentUid) {
  const db = _syncLoad();
  for (const [sid, s] of Object.entries(db.sessions || {})) {
    if (s.agent_uid === agentUid) return sid;
  }
  return null;
}

function countAgentSessions(agentUid) {
  return Object.values(_syncLoad().sessions).filter((s) => s.agent_uid === agentUid).length;
}

// ── PM identity ────────────────────────────────────────────────────────

async function setAgentProject(uid, project) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    agent.project = project || null;
    agent.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

async function setAgentPM(uid, pmOfProjects) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    agent.pm_of = Array.isArray(pmOfProjects) ? pmOfProjects.slice(0, 20) : [];
    agent.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

function isPMOf(agent, project) {
  if (!agent) return false;
  if (agent.role === 'supervisor') return true;
  if (!project || !agent.pm_of) return false;
  return agent.pm_of.includes(project);
}

// ── heartbeat ──────────────────────────────────────────────────────────

async function touchAgentHeartbeat(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.last_seen_at = new Date().toISOString();
    if (agent.unresponsive) agent.unresponsive = false;
    await _save(db);
  });
}

async function setAgentUnresponsive(uid, unresponsive) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.unresponsive = unresponsive;
    agent.last_unresponsive_at = unresponsive ? new Date().toISOString() : agent.last_unresponsive_at;
    await _save(db);
  });
}

module.exports = {
  // Agent CRUD
  findAgentByNameWs, getAgent, insertAgent, touchAgent, deleteAgent, migrateAgentUid,
  listAgentsInWorkspace, listAllAgentsInWorkspace, listAllAgents, countStaleAgents,
  genTaskId,
  // Sessions
  bindSession, unbindSession, getSessionAgentUid, getSessionByAgentUid, countAgentSessions,
  // PM identity
  setAgentProject, setAgentPM, isPMOf,
  // Heartbeat
  touchAgentHeartbeat, setAgentUnresponsive,
};
