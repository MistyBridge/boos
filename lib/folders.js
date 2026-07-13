'use strict';

// User-curated folders. Sessions reference these by id. Order is
// user-controlled (drag-reorder in sidebar). The store is a flat list
// in $DATA_DIR/folders.json:
//   [{ id, name, order, createdAt }]
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
    // Allow rename + reorder, ignore other keys.
    const allowed = {};
    if (id !== UNSORTED_ID && typeof patch.name === 'string') allowed.name = patch.name.trim();
    if (typeof patch.order === 'number') allowed.order = patch.order;
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

module.exports = { loadAll, create, update, remove, reorder, FILE };
