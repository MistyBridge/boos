'use strict';

// User-curated folders. Sessions reference these by id. Order is
// user-controlled (drag-reorder in sidebar). The store is a flat list
// in $DATA_DIR/folders.json:
//   [{ id, name, order, createdAt, rootPath? }]
//
// rootPath (Sprint 11): optional absolute path that sandboxes all agents
// in this folder to the given directory. PM/supervisor agents bypass
// the sandbox. Set via PUT /api/folders/:id/root-path.
//
// Top-level "Unsorted" is implicit — sessions with folderId === null
// render under it. The user can't delete or rename it; we just synthesise
// the bucket in the frontend.

const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./config');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

const FILE = path.join(DATA_DIR, 'folders.json');

// Sentinel for the synthetic "Unsorted" folder. Sessions with
// folderId === null render under it. We always materialize it in the
// returned list so the sidebar can drag-reorder it like a real folder,
// but create/update/delete refuse to touch it.
const UNSORTED_ID = 'unsorted';
function unsortedDefault(order) {
  return { id: UNSORTED_ID, name: 'Unsorted', order, builtin: true };
}

async function loadAll() {
  let list = [];
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const j = JSON.parse(raw);
    if (Array.isArray(j)) list = j;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Ensure the synthetic Unsorted entry is present. New install: append
  // at the end. Existing install pre-Unsorted-draggable: same.
  if (!list.find((f) => f.id === UNSORTED_ID)) {
    list = list.concat(unsortedDefault(list.length));
  }
  return list;
}

async function saveAll(list) {
  await atomicWriteJson(FILE, list);
}

function genId() {
  return 'folder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function create({ name }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const entry = {
      id: genId(),
      name: name.trim(),
      order: list.length,
      createdAt: Date.now(),
    };
    list.push(entry);
    await saveAll(list);
    return entry;
  });
}

async function update(id, patch) {
  if (id === UNSORTED_ID && typeof patch.name === 'string') {
    throw new Error('cannot rename the Unsorted bucket');
  }
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    // Allow rename + reorder + rootPath, ignore other keys.
    const allowed = {};
    if (id !== UNSORTED_ID && typeof patch.name === 'string') allowed.name = patch.name.trim();
    if (typeof patch.order === 'number') allowed.order = patch.order;
    if (typeof patch.rootPath === 'string') allowed.rootPath = patch.rootPath.trim();
    if (patch.rootPath === null) allowed.rootPath = null;  // allow clearing
    // Sprint 13.1: agent permission levels per folder { uid: "PM"|"SE" }
    if (patch.agentLevels && typeof patch.agentLevels === 'object') allowed.agentLevels = patch.agentLevels;
    list[idx] = { ...list[idx], ...allowed };
    await saveAll(list);
    return list[idx];
  });
}

async function remove(id) {
  if (id === UNSORTED_ID) throw new Error('cannot delete the Unsorted bucket');
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    await saveAll(list);
    return true;
  });
}

async function reorder(idsInOrder) {
  if (!Array.isArray(idsInOrder)) throw new Error('idsInOrder must be array');
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const byId = new Map(list.map((f) => [f.id, f]));
    const next = [];
    idsInOrder.forEach((id, i) => {
      const f = byId.get(id);
      if (f) {
        f.order = i;
        next.push(f);
        byId.delete(id);
      }
    });
    // Append any folders not mentioned in the new order, preserving original
    // relative order. Prevents accidentally dropping folders.
    for (const f of byId.values()) {
      f.order = next.length;
      next.push(f);
    }
    await saveAll(next);
    return next;
  });
}

// Sprint 11: set the sandbox root path for a folder.
// All agents in this folder will be restricted to this directory
// for filesystem operations (MCP filesystem, file tools). PM/supervisor
// agents bypass this restriction.
async function setRootPath(id, rootPath) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    list[idx].rootPath = rootPath || null;
    await saveAll(list);
    return list[idx];
  });
}

// Get the sandbox root path for a folder. Returns null if no sandbox set.
async function getRootPath(id) {
  const list = await loadAll();
  const folder = list.find((f) => f.id === id);
  return folder ? (folder.rootPath || null) : null;
}

// Sprint 13.1: agent permission levels per folder.
// Sprint 13.2: extended to { sandbox: "PM"|"SE", write: boolean }.
// Backward-compat: legacy "PM"/"SE" string values auto-normalized.

function normalizeLevel(raw) {
  if (!raw || typeof raw === 'string') {
    return { sandbox: raw || 'SE', write: raw === 'PM' };
  }
  if (typeof raw === 'object') {
    return {
      sandbox: raw.sandbox === 'PM' ? 'PM' : 'SE',
      write: raw.sandbox === 'PM' ? true : Boolean(raw.write),
    };
  }
  return { sandbox: 'SE', write: false };
}

function normalizeLevels(levels) {
  if (!levels || typeof levels !== 'object') return {};
  const out = {};
  for (const [uid, raw] of Object.entries(levels)) {
    out[uid] = normalizeLevel(raw);
  }
  return out;
}

async function setAgentLevels(id, levels) {
  return withFileLock(FILE, async () => {
    const list = await loadAll();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    list[idx].agentLevels = normalizeLevels(levels || {});
    await saveAll(list);
    return list[idx];
  });
}

async function getAgentLevels(id) {
  const list = await loadAll();
  const folder = list.find((f) => f.id === id);
  if (!folder || !folder.agentLevels) return {};
  return normalizeLevels(folder.agentLevels);
}

// Helper: get a single agent's level from a folder.
async function getAgentLevel(id, agentUid) {
  const levels = await getAgentLevels(id);
  return normalizeLevel(levels[agentUid] || 'SE');
}

module.exports = { loadAll, create, update, remove, reorder, setRootPath, getRootPath, setAgentLevels, getAgentLevels, getAgentLevel, normalizeLevel, FILE };
