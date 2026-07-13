'use strict';

// Factory for a keyed-JSON store under $DATA_DIR. Both favorites and labels
// have the same shape: a JSON object keyed by sessionId, written atomically
// on each mutation, with ENOENT swallowed to empty.
//
//   const store = createKeyedJsonStore({ filename: 'foo.json', transformValue: (v) => ... })
//   await store.load()        → object
//   await store.set(key, v)   → returns the stored value (or null if removed)
//   await store.remove(key)   → returns true if it existed
//   await store.list()        → array of values

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson, withFileLock } = require('./atomicJson');

function createKeyedJsonStore({ dataDir, filename, transformValue = (v) => v }) {
  const filePath = path.join(dataDir, filename);

  async function load() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  async function save(map) {
    await atomicWriteJson(filePath, map);
  }

  async function set(key, value) {
    if (!key) throw new Error('set: key required');
    const next = transformValue(value, key);
    if (next == null) return remove(key);
    return withFileLock(filePath, async () => {
      const map = await load();
      map[key] = next;
      await save(map);
      return next;
    });
  }

  async function remove(key) {
    return withFileLock(filePath, async () => {
      const map = await load();
      if (!(key in map)) return false;
      delete map[key];
      await save(map);
      return true;
    });
  }

  async function list() {
    const map = await load();
    return Object.values(map);
  }

  return { load, save, set, remove, list, filePath };
}

module.exports = { createKeyedJsonStore };
