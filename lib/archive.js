// File archive system — 30-day auto-expiry for completed tasks and decided decisions.
//
// Archive lives at ~/.boos/archive/<type>/<yyyy-mm>/<id>.json
// Each entry records original data + archived_at + expires_at.
//
// REST API in routes/archive.js.
// Auto-prune runs on server start + daily interval.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { DATA_DIR } = require('./config');

const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _archivePath(type, id) {
  const now = new Date();
  const month = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const dir = path.join(ARCHIVE_DIR, type, month);
  _ensureDir(dir);
  return path.join(dir, String(id).replace(/[<>:"/\\|?*]/g, '_') + '.json');
}

// ── core API ────────────────────────────────────────────────────────────

function archive(type, id, data) {
  try {
    const entry = {
      type,
      id: String(id),
      data,
      archived_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const fp = _archivePath(type, id);
    fs.writeFileSync(fp, JSON.stringify(entry, null, 2), 'utf-8');
    return { ok: true, path: fp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function restore(type, id) {
  try {
    const fp = _findFile(type, id);
    if (!fp) return { ok: false, error: 'not found in archive' };
    const raw = fs.readFileSync(fp, 'utf-8');
    const entry = JSON.parse(raw);
    // Don't delete on restore — keep as recovered marker. Caller can delete after recovery.
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getArchivedItem(type, id) {
  try {
    const fp = _findFile(type, id);
    if (!fp) return null;
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listArchive(type, opts = {}) {
  const { limit = 50, offset = 0 } = opts;
  const results = [];
  const typeDir = path.join(ARCHIVE_DIR, type);
  if (!fs.existsSync(typeDir)) return { items: [], total: 0 };

  const months = fs.readdirSync(typeDir).filter(d => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  for (const month of months) {
    const monthDir = path.join(typeDir, month);
    let files;
    try { files = fs.readdirSync(monthDir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files.sort().reverse()) {
      try {
        const raw = fs.readFileSync(path.join(monthDir, f), 'utf-8');
        const entry = JSON.parse(raw);
        results.push({
          type: entry.type,
          id: entry.id,
          archived_at: entry.archived_at,
          expires_at: entry.expires_at,
          size: raw.length,
        });
      } catch {}
    }
  }

  const total = results.length;
  return { items: results.slice(offset, offset + limit), total };
}

function deleteArchived(type, id) {
  try {
    const fp = _findFile(type, id);
    if (!fp) return { ok: false, error: 'not found' };
    fs.unlinkSync(fp);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── prune expired items ────────────────────────────────────────────────

function pruneExpired() {
  const now = Date.now();
  let removed = 0;
  if (!fs.existsSync(ARCHIVE_DIR)) return { removed: 0, errors: [] };
  const errors = [];

  const types = fs.readdirSync(ARCHIVE_DIR).filter(d => {
    try { return fs.statSync(path.join(ARCHIVE_DIR, d)).isDirectory(); } catch { return false; }
  });

  for (const type of types) {
    const typeDir = path.join(ARCHIVE_DIR, type);
    const months = fs.readdirSync(typeDir).filter(d => /^\d{4}-\d{2}$/.test(d));
    for (const month of months) {
      const monthDir = path.join(typeDir, month);
      let files;
      try { files = fs.readdirSync(monthDir).filter(f => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(monthDir, f);
        try {
          const raw = fs.readFileSync(fp, 'utf-8');
          const entry = JSON.parse(raw);
          if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
            fs.unlinkSync(fp);
            removed++;
          }
        } catch (e) {
          errors.push(fp + ': ' + e.message);
        }
      }
      // Remove empty month directories.
      try {
        const remaining = fs.readdirSync(monthDir).filter(x => x.endsWith('.json'));
        if (remaining.length === 0) fs.rmdirSync(monthDir);
      } catch {}
    }
  }

  return { removed, errors };
}

// ── helpers ─────────────────────────────────────────────────────────────

function _findFile(type, id) {
  const cleanId = String(id).replace(/[<>:"/\\|?*]/g, '_');
  const typeDir = path.join(ARCHIVE_DIR, type);
  if (!fs.existsSync(typeDir)) return null;

  const months = fs.readdirSync(typeDir).filter(d => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  for (const month of months) {
    const fp = path.join(typeDir, month, cleanId + '.json');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// ── bulk archive helper for agent-bus tasks ─────────────────────────────

function archiveTasksOlderThan(daysAgo) {
  const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  // This is called from store.js which holds the lock, so we read directly.
  try {
    const store = require('./agentBus/store');
    const db = JSON.parse(fs.readFileSync(store.DB_PATH, 'utf-8'));
    let count = 0;
    const toArchive = [];
    for (const [tid, t] of Object.entries(db.tasks || {})) {
      if ((t.status === 'completed' || t.status === 'cancelled' || t.status === 'exhausted') &&
          t.updated_at && t.updated_at < cutoff) {
        toArchive.push(tid);
      }
    }
    for (const tid of toArchive) {
      const task = db.tasks[tid];
      archive('tasks', tid, task);
      delete db.tasks[tid];
      count++;
    }
    if (count > 0) {
      const { atomicWriteJson } = require('./atomicJson');
      atomicWriteJson(store.DB_PATH, db);
    }
    return { archived: count };
  } catch (e) {
    return { error: e.message, archived: 0 };
  }
}

// Schedule periodic prune (runs every 24h).
let _pruneTimer = null;
function startPeriodicPrune() {
  if (_pruneTimer) return;
  // Run once at startup.
  try { const r = pruneExpired(); if (r.removed > 0) console.log('[archive] startup prune: removed', r.removed, 'expired items'); } catch {}
  // Then every 24 hours.
  _pruneTimer = setInterval(() => {
    try { const r = pruneExpired(); if (r.removed > 0) console.log('[archive] periodic prune: removed', r.removed, 'expired items'); } catch {}
  }, 24 * 60 * 60 * 1000).unref();
}

function stopPeriodicPrune() {
  if (_pruneTimer) { clearInterval(_pruneTimer); _pruneTimer = null; }
}

module.exports = {
  archive, restore, getArchivedItem, listArchive, deleteArchived,
  pruneExpired, archiveTasksOlderThan,
  startPeriodicPrune, stopPeriodicPrune,
};
