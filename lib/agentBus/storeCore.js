// Shared core for store.js / storeTasks.js / storeIdentity.js.
// Extracted to break circular dependencies — both store.js and its
// sub-modules require this file, so _load / _syncLoad / DB_PATH are
// always available without circular require warnings.

'use strict';

const path = require('path');
const fs = require('node:fs/promises');
const { atomicWriteJson, withFileLock } = require('../atomicJson');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'agent-bus.json');

const EMPTY_DB = { agents: {}, tasks: {}, name_ws_index: {}, sessions: {}, identities: {}, identity_by_mcp_session: {}, identity_by_name_ws: {}, dags: {}, dag_tasks: {} };

async function _load() {
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const db = JSON.parse(raw);
    return {
      agents: db.agents || {}, tasks: db.tasks || {},
      name_ws_index: db.name_ws_index || {}, sessions: db.sessions || {},
      identities: db.identities || {}, identity_by_mcp_session: db.identity_by_mcp_session || {},
      identity_by_name_ws: db.identity_by_name_ws || {},
      dags: db.dags || {}, dag_tasks: db.dag_tasks || {},
    };
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw e;
  }
}

function _syncLoad() {
  try {
    const db = JSON.parse(require('fs').readFileSync(FILE, 'utf-8'));
    db.identities = db.identities || {};
    db.identity_by_mcp_session = db.identity_by_mcp_session || {};
    db.identity_by_name_ws = db.identity_by_name_ws || {};
    db.dags = db.dags || {};
    db.dag_tasks = db.dag_tasks || {};
    return db;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[agent-bus] _syncLoad: failed to parse agent-bus.json — returning empty DB. Error:', e.message);
    }
    return structuredClone(EMPTY_DB);
  }
}

async function _save(db) {
  await atomicWriteJson(FILE, db);
}

const DB_PATH = FILE;

module.exports = { _load, _syncLoad, _save, DB_PATH, DATA_DIR, withFileLock, atomicWriteJson, EMPTY_DB };
