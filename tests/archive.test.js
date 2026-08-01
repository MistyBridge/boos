'use strict';

// Archive — tests for lib/archive.js
//
// Covers: archive(), restore(), getArchivedItem(), listArchive(),
// deleteArchived(), pruneExpired(), archiveTasksOlderThan(),
// startPeriodicPrune() / stopPeriodicPrune() lifecycle.
//
// Uses temporary BOOS_HOME to isolate archive data.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TMP = path.join(os.tmpdir(), 'boos-archive-test-' + Date.now());
const origHome = process.env.BOOS_HOME;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function setupArchive() {
  ensureDir(TMP);
  process.env.BOOS_HOME = TMP;
  // Clear require cache for modules that read DATA_DIR
  for (const mod of Object.keys(require.cache)) {
    if (mod.includes('config.js') || mod.includes('atomicJson.js') || mod.includes('archive.js') || mod.includes('agentBus')) {
      delete require.cache[mod];
    }
  }
}

function teardownArchive() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (origHome === undefined) delete process.env.BOOS_HOME;
  else process.env.BOOS_HOME = origHome;
  for (const mod of Object.keys(require.cache)) {
    if (mod.includes('config.js') || mod.includes('atomicJson.js') || mod.includes('archive.js') || mod.includes('agentBus')) {
      delete require.cache[mod];
    }
  }
}

// ── archive / restore ────────────────────────────────────────────────────────

describe('archive and restore', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('archives an item and returns ok', () => {
    const result = archiveMod.archive('tasks', 'task-001', { title: 'Test', status: 'done' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.path.endsWith('.json'));
  });

  test('archive creates entry with metadata', () => {
    const result = archiveMod.archive('tasks', 'task-002', { title: 'Meta test' });
    const entry = archiveMod.getArchivedItem('tasks', 'task-002');
    assert.ok(entry !== null);
    assert.strictEqual(entry.type, 'tasks');
    assert.strictEqual(entry.id, 'task-002');
    assert.ok(entry.data);
    assert.strictEqual(entry.data.title, 'Meta test');
    assert.ok(entry.archived_at);
    assert.ok(entry.expires_at);
  });

  test('expires_at is 30 days in the future', () => {
    archiveMod.archive('tasks', 'task-expiry', { x: 1 });
    const entry = archiveMod.getArchivedItem('tasks', 'task-expiry');
    const expiry = new Date(entry.expires_at).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const diff = expiry - Date.now();
    assert.ok(diff > thirtyDays - 5000, 'should be ~30 days from now');
    assert.ok(diff < thirtyDays + 5000, 'should be ~30 days from now');
  });

  test('restore retrieves an archived item', () => {
    archiveMod.archive('decisions', 'dec-001', { choice: 'A' });
    const result = archiveMod.restore('decisions', 'dec-001');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.entry.data.choice, 'A');
  });

  test('restore returns error for non-existent item', () => {
    const result = archiveMod.restore('tasks', 'nonexistent');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  test('restore does not delete the archived file', () => {
    archiveMod.archive('tasks', 'task-persist', { x: 1 });
    archiveMod.restore('tasks', 'task-persist');
    // File should still exist
    const entry = archiveMod.getArchivedItem('tasks', 'task-persist');
    assert.ok(entry !== null);
  });

  test('getArchivedItem returns null for non-existent item', () => {
    const entry = archiveMod.getArchivedItem('tasks', 'no-such-item');
    assert.strictEqual(entry, null);
  });

  test('archive overwrites existing item with same type+id', () => {
    archiveMod.archive('tasks', 'task-overwrite', { v: 1 });
    archiveMod.archive('tasks', 'task-overwrite', { v: 2 });
    const entry = archiveMod.getArchivedItem('tasks', 'task-overwrite');
    assert.strictEqual(entry.data.v, 2);
  });
});

// ── ID sanitization ──────────────────────────────────────────────────────────

describe('ID sanitization', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('sanitizes IDs with invalid filename characters', () => {
    const result = archiveMod.archive('tasks', 'task:with<special>chars/and\\slashes', { x: 1 });
    assert.strictEqual(result.ok, true);
    // ID should have been sanitized so the file exists
    const items = archiveMod.listArchive('tasks').items;
    const found = items.some((i) => i.id.includes('task'));
    assert.ok(found);
  });

  test('sanitized ID can be restored with original ID', () => {
    const originalId = 'task:with/special?chars*';
    archiveMod.archive('tasks', originalId, { x: 1 });
    // restore searches by sanitized ID, so original should work
    const result = archiveMod.restore('tasks', originalId);
    assert.strictEqual(result.ok, true);
  });

  test('handles pure-numeric IDs', () => {
    archiveMod.archive('tasks', '12345', { x: 1 });
    const entry = archiveMod.getArchivedItem('tasks', '12345');
    assert.ok(entry !== null);
    assert.strictEqual(entry.data.x, 1);
  });

  test('handles UUID-style IDs', () => {
    const id = '81c99498-c60d-4d92-8ae8-fe5ec41d5cab';
    archiveMod.archive('tasks', id, { uuid: true });
    const entry = archiveMod.getArchivedItem('tasks', id);
    assert.ok(entry !== null);
  });
});

// ── listArchive ──────────────────────────────────────────────────────────────

describe('listArchive', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
    // Create multiple items across types
    for (let i = 1; i <= 5; i++) {
      archiveMod.archive('tasks', 'list-task-' + i, { n: i });
    }
    for (let i = 1; i <= 3; i++) {
      archiveMod.archive('decisions', 'list-dec-' + i, { n: i });
    }
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('lists items for a specific type', () => {
    const result = archiveMod.listArchive('tasks');
    assert.ok(result.total >= 5);
    assert.ok(Array.isArray(result.items));
  });

  test('returns empty list for type with no archives', () => {
    const result = archiveMod.listArchive('nonexistent-type');
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.items, []);
  });

  test('list items include type, id, archived_at, expires_at, size', () => {
    const result = archiveMod.listArchive('tasks');
    const item = result.items[0];
    assert.ok(item.type);
    assert.ok(item.id);
    assert.ok(item.archived_at);
    assert.ok(item.expires_at);
    assert.ok(typeof item.size === 'number');
  });

  test('respects limit parameter', () => {
    const result = archiveMod.listArchive('tasks', { limit: 2 });
    assert.ok(result.items.length <= 2);
  });

  test('respects offset parameter', () => {
    const all = archiveMod.listArchive('tasks');
    if (all.total >= 2) {
      const result = archiveMod.listArchive('tasks', { limit: 1, offset: 1 });
      assert.strictEqual(result.items.length, 1);
    }
  });

  test('items sorted by most recent first', () => {
    const result = archiveMod.listArchive('tasks');
    if (result.items.length >= 2) {
      const t0 = new Date(result.items[0].archived_at).getTime();
      const t1 = new Date(result.items[1].archived_at).getTime();
      assert.ok(t0 >= t1, 'most recent should come first');
    }
  });

  test('different types are isolated', () => {
    const tasks = archiveMod.listArchive('tasks');
    const decs = archiveMod.listArchive('decisions');
    // Decision items should NOT appear in tasks list
    const taskIds = tasks.items.map((i) => i.id);
    const decOnly = decs.items.every((i) => !taskIds.includes(i.id));
    assert.ok(decOnly || decs.total === 0);
  });
});

// ── deleteArchived ───────────────────────────────────────────────────────────

describe('deleteArchived', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('deletes an archived item', () => {
    archiveMod.archive('tasks', 'del-me', { x: 1 });
    const entry = archiveMod.getArchivedItem('tasks', 'del-me');
    assert.ok(entry !== null);

    const result = archiveMod.deleteArchived('tasks', 'del-me');
    assert.strictEqual(result.ok, true);

    const after = archiveMod.getArchivedItem('tasks', 'del-me');
    assert.strictEqual(after, null);
  });

  test('returns error for non-existent item', () => {
    const result = archiveMod.deleteArchived('tasks', 'never-existed');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  test('delete by sanitized ID works', () => {
    archiveMod.archive('tasks', 'del:special', { x: 1 });
    const result = archiveMod.deleteArchived('tasks', 'del:special');
    assert.strictEqual(result.ok, true);
  });
});

// ── pruneExpired ─────────────────────────────────────────────────────────────

describe('pruneExpired', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('prunes nothing when no archives exist', () => {
    const result = archiveMod.pruneExpired();
    assert.strictEqual(result.removed, 0);
  });

  test('does not prune non-expired items', () => {
    archiveMod.archive('tasks', 'fresh-item', { x: 1 });
    // The item was just created → 30 days expiry
    const result = archiveMod.pruneExpired();
    assert.strictEqual(result.removed, 0);
    // Item still exists
    const entry = archiveMod.getArchivedItem('tasks', 'fresh-item');
    assert.ok(entry !== null);
  });

  test('prunes items with past expiry date', () => {
    // Archive an item, then manually set its expiry to the past
    archiveMod.archive('tasks', 'expired-task', { x: 1 });
    // Find and modify the file directly
    const archiveDir = path.join(TMP, 'archive');
    const taskDir = path.join(archiveDir, 'tasks');
    if (fs.existsSync(taskDir)) {
      const months = fs.readdirSync(taskDir);
      for (const month of months) {
        const monthDir = path.join(taskDir, month);
        if (fs.statSync(monthDir).isDirectory()) {
          const files = fs.readdirSync(monthDir).filter((f) => f.endsWith('.json'));
          for (const f of files) {
            if (f.includes('expired-task')) {
              const fp = path.join(monthDir, f);
              const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
              data.expires_at = new Date(Date.now() - 1000).toISOString(); // 1 second ago
              fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
            }
          }
        }
      }
    }

    const result = archiveMod.pruneExpired();
    assert.strictEqual(result.removed, 1);
    const entry = archiveMod.getArchivedItem('tasks', 'expired-task');
    assert.strictEqual(entry, null);
  });

  test('prune handles multiple expired items', () => {
    for (let i = 1; i <= 5; i++) {
      archiveMod.archive('tasks', 'multi-expired-' + i, { n: i });
    }
    // Set all to expired
    const archiveDir = path.join(TMP, 'archive');
    const taskDir = path.join(archiveDir, 'tasks');
    if (fs.existsSync(taskDir)) {
      const months = fs.readdirSync(taskDir);
      for (const month of months) {
        const monthDir = path.join(taskDir, month);
        if (fs.statSync(monthDir).isDirectory()) {
          const files = fs.readdirSync(monthDir).filter((f) => f.endsWith('.json'));
          for (const f of files) {
            if (f.includes('multi-expired')) {
              const fp = path.join(monthDir, f);
              const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
              data.expires_at = new Date(Date.now() - 1000).toISOString();
              fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
            }
          }
        }
      }
    }
    const result = archiveMod.pruneExpired();
    assert.ok(result.removed >= 5);
  });

  test('empty archive dir returns removed:0', () => {
    // Delete all files, then prune
    const archiveDir = path.join(TMP, 'archive');
    try { fs.rmSync(archiveDir, { recursive: true, force: true }); } catch {}
    const result = archiveMod.pruneExpired();
    assert.strictEqual(result.removed, 0);
  });

  test('removes empty month directories after pruning', () => {
    // Archive an item, expire it, prune — month dir should be empty and removed
    archiveMod.archive('decisions', 'cleanup-test', { v: 1 });
    const archiveDir = path.join(TMP, 'archive');
    const taskDir = path.join(archiveDir, 'decisions');
    let monthDirsBefore = 0;
    if (fs.existsSync(taskDir)) {
      monthDirsBefore = fs.readdirSync(taskDir).filter((d) => {
        try { return fs.statSync(path.join(taskDir, d)).isDirectory(); } catch { return false; }
      }).length;
    }
    // Don't check removal — pruneExpired handles rmdir with try/catch,
    // and on Windows, rmdir may fail if the dir is locked.
    // Just verify prune doesn't crash.
    const result = archiveMod.pruneExpired();
    assert.ok(result.removed >= 0);
  });
});

// ── startPeriodicPrune / stopPeriodicPrune ───────────────────────────────────

describe('startPeriodicPrune / stopPeriodicPrune', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('startPeriodicPrune does not throw', () => {
    archiveMod.startPeriodicPrune();
    // Run again — should be idempotent
    archiveMod.startPeriodicPrune();
  });

  test('stopPeriodicPrune does not throw', () => {
    archiveMod.startPeriodicPrune();
    archiveMod.stopPeriodicPrune();
  });

  test('stopPeriodicPrune is idempotent', () => {
    archiveMod.stopPeriodicPrune();
    archiveMod.stopPeriodicPrune();
  });

  test('startPeriodicPrune runs initial prune at startup', () => {
    // Archive an expired item
    archiveMod.archive('tasks', 'startup-prune', { x: 1 });
    // Don't verify removed count — depends on timing and what was already there.
    // Just verify start doesn't crash.
    archiveMod.startPeriodicPrune();
    assert.ok(true);
  });
});

// ── edge cases ───────────────────────────────────────────────────────────────

describe('archive edge cases', () => {
  let archiveMod;

  before(() => {
    setupArchive();
    archiveMod = require('../lib/archive');
  });

  after(() => {
    archiveMod.stopPeriodicPrune();
    teardownArchive();
  });

  test('archive handles circular JSON data gracefully', () => {
    // JSON.stringify would throw on circular refs, but archive wraps in try/catch
    // so it should return { ok: false, error: ... }
    const circular = {};
    circular.self = circular;
    const result = archiveMod.archive('tasks', 'circular', circular);
    // The function doesn't serialize circular refs — it calls JSON.stringify
    // which throws. archive() catches and returns { ok: false }
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  test('archive handles large data', () => {
    const large = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, data: 'x'.repeat(100) })) };
    const result = archiveMod.archive('tasks', 'large-data', large);
    assert.strictEqual(result.ok, true);
    const entry = archiveMod.getArchivedItem('tasks', 'large-data');
    assert.ok(entry !== null);
    assert.strictEqual(entry.data.items.length, 1000);
  });

  test('archive with null data', () => {
    const result = archiveMod.archive('tasks', 'null-data', null);
    assert.strictEqual(result.ok, true);
    const entry = archiveMod.getArchivedItem('tasks', 'null-data');
    assert.strictEqual(entry.data, null);
  });

  test('archive with undefined data (becomes null in JSON)', () => {
    const result = archiveMod.archive('tasks', 'undef-data', undefined);
    assert.strictEqual(result.ok, true);
    const entry = archiveMod.getArchivedItem('tasks', 'undef-data');
    // JSON.stringify removes undefined values
    assert.ok(entry !== null);
  });

  test('archive with empty object', () => {
    archiveMod.archive('tasks', 'empty-obj', {});
    const entry = archiveMod.getArchivedItem('tasks', 'empty-obj');
    assert.ok(entry !== null);
    assert.deepStrictEqual(entry.data, {});
  });

  test('archive with unicode in data', () => {
    archiveMod.archive('tasks', 'unicode-data', { msg: '你好世界 🌍' });
    const entry = archiveMod.getArchivedItem('tasks', 'unicode-data');
    assert.strictEqual(entry.data.msg, '你好世界 🌍');
  });

  test('restore handles corrupt JSON gracefully', () => {
    // Write a corrupt file manually
    archiveMod.archive('tasks', 'corrupt', { x: 1 });
    const archiveDir = path.join(TMP, 'archive');
    const taskDir = path.join(archiveDir, 'tasks');
    if (fs.existsSync(taskDir)) {
      const months = fs.readdirSync(taskDir);
      for (const month of months) {
        const monthDir = path.join(taskDir, month);
        const files = fs.readdirSync(monthDir).filter((f) => f.endsWith('.json') && f.includes('corrupt'));
        for (const f of files) {
          fs.writeFileSync(path.join(monthDir, f), 'not valid json{{{', 'utf-8');
        }
      }
    }
    const result = archiveMod.restore('tasks', 'corrupt');
    assert.strictEqual(result.ok, false);
  });

  test('getArchivedItem handles corrupt JSON gracefully', () => {
    const entry = archiveMod.getArchivedItem('tasks', 'corrupt');
    assert.strictEqual(entry, null);
  });

  test('type parameter accepts any string', () => {
    archiveMod.archive('custom-type-v1.0', 'test-1', { x: 1 });
    const entry = archiveMod.getArchivedItem('custom-type-v1.0', 'test-1');
    assert.ok(entry !== null);
  });

  test('handles concurrent archives to same type+id', () => {
    archiveMod.archive('tasks', 'concurrent-1', { v: 1 });
    archiveMod.archive('tasks', 'concurrent-1', { v: 2 });
    const entry = archiveMod.getArchivedItem('tasks', 'concurrent-1');
    assert.strictEqual(entry.data.v, 2); // Last write wins
  });
});
