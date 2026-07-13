'use strict';

// persistedSessions.js depends on config.js DATA_DIR which reads
// process.env.BOOS_HOME at require-time. Configure a temp dir before
// requiring so we don't touch the real ~/.boos/sessions.json.
// Also purge require cache so this works when run alongside other
// test files that also load config.js.
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const tmpBase = path.join(os.tmpdir(), 'boos-psess-' + Date.now().toString(36));
fs.mkdirSync(tmpBase, { recursive: true });
process.env.BOOS_HOME = tmpBase;

// Purge cached config.js (and transitive deps) so BOOS_HOME takes effect
for (const key of Object.keys(require.cache)) {
  if (key.includes('boos\\lib\\')) delete require.cache[key];
}

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Must require AFTER BOOS_HOME is set
const sessions = require('../lib/persistedSessions');

afterEach(async () => {
  // Clean sessions.json between tests, keep tmpBase intact
  try { await fsp.unlink(sessions.FILE); } catch {}
});

// Clean up tmpBase only once at the end
afterEach(async () => {}); // no-op — cleanup handled by os tmp auto-purge

describe('persistedSessions · core CRUD', () => {
  test('create() returns a well-formed session entry', async () => {
    const entry = await sessions.create({
      cliId: 'claude',
      cwd: '/fake/project',
      workspace: 'ws-1',
    });

    assert.ok(entry.id.startsWith('sess-'), `unexpected id: ${entry.id}`);
    assert.equal(entry.cliId, 'claude');
    assert.equal(entry.cwd, '/fake/project');
    assert.equal(entry.workspace, 'ws-1');
    assert.equal(entry.status, 'running');
    assert.equal(entry.repos.length, 0);
    assert.equal(entry.folderId, null);
    assert.equal(entry.manualStopped, false);
    assert.ok(typeof entry.createdAt === 'number');
    assert.ok(typeof entry.lastActiveAt === 'number');
  });

  test('loadAll() returns created sessions', async () => {
    const e1 = await sessions.create({ cliId: 'claude', cwd: '/a', workspace: 'ws-1' });
    const e2 = await sessions.create({ cliId: 'codex', cwd: '/b', workspace: 'ws-2' });

    const all = await sessions.loadAll();
    assert.equal(all.length, 2);
    const ids = all.map((s) => s.id).sort();
    assert.deepEqual(ids, [e1.id, e2.id].sort());
  });

  test('get() finds a session by id', async () => {
    const created = await sessions.create({ cliId: 'claude', cwd: '/x', workspace: 'ws-1' });
    const found = await sessions.get(created.id);
    // normalizeEntry adds deletedAt/deletedFromFolderId/deletedFromOrder
    // on read-all, so deepEqual won't match freshly created entries.
    assert.equal(found.id, created.id);
    assert.equal(found.cliId, created.cliId);
    assert.equal(found.cwd, created.cwd);
    assert.equal(found.status, 'running');

    const missing = await sessions.get('nonexistent-id');
    assert.equal(missing, null);
  });

  test('update() patches fields on a session', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/proj', workspace: 'ws-1' });
    const updated = await sessions.update(entry.id, { title: 'My Session', status: 'exited' });

    assert.equal(updated.title, 'My Session');
    assert.equal(updated.status, 'exited');
    assert.equal(updated.id, entry.id); // id unchanged
  });

  test('update() returns null for nonexistent id', async () => {
    const result = await sessions.update('no-such-id', { title: 'x' });
    assert.equal(result, null);
  });

  test('remove() soft-deletes a session', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/rm', workspace: 'ws-1' });
    const result = await sessions.remove(entry.id);
    assert.equal(result, true);

    // Should not appear in loadAll()
    const all = await sessions.loadAll();
    assert.equal(all.find((s) => s.id === entry.id), undefined);

    // Should appear in loadDeleted()
    const deleted = await sessions.loadDeleted();
    const found = deleted.find((s) => s.id === entry.id);
    assert.ok(found, 'should be in deleted list');
    assert.ok(typeof found.deletedAt === 'number' && found.deletedAt > 0);
    assert.equal(found.status, 'exited');
    assert.equal(found.manualStopped, true);
  });

  test('remove() returns false for nonexistent id', async () => {
    const result = await sessions.remove('no-such-id');
    assert.equal(result, false);
  });
});

describe('persistedSessions · restore', () => {
  test('restore() recovers a soft-deleted session', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/restore', workspace: 'ws-1' });
    await sessions.remove(entry.id);

    const restored = await sessions.restore(entry.id);
    assert.ok(restored, 'restore returned falsy');
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.status, 'exited');
    assert.equal(restored.manualStopped, true);

    // Should now appear in loadAll()
    const all = await sessions.loadAll();
    assert.ok(all.find((s) => s.id === entry.id), 'should be back in active list');
  });

  test('restore() returns null for non-deleted session', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/active', workspace: 'ws-1' });
    const result = await sessions.restore(entry.id);
    assert.equal(result, null);
  });

  test('restore() returns null for nonexistent id', async () => {
    const result = await sessions.restore('no-such-id');
    assert.equal(result, null);
  });
});

describe('persistedSessions · convenience helpers', () => {
  test('markRunning() sets status and pid', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/run', workspace: 'ws-1' });
    await sessions.update(entry.id, { status: 'exited', exitCode: 0 }); // simulate exit first
    const updated = await sessions.markRunning(entry.id, 12345);

    assert.equal(updated.status, 'running');
    assert.equal(updated.pid, 12345);
    assert.equal(updated.exitedAt, null);
    assert.equal(updated.exitCode, null);
    assert.equal(updated.manualStopped, false);
  });

  test('markExited() sets status and exitCode', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/exit', workspace: 'ws-1' });
    const updated = await sessions.markExited(entry.id, 1);

    assert.equal(updated.status, 'exited');
    assert.equal(updated.exitCode, 1);
    assert.ok(typeof updated.exitedAt === 'number');
    assert.equal(updated.pid, null);
  });

  test('touch() updates lastActiveAt', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/touch', workspace: 'ws-1' });
    const original = entry.lastActiveAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    const touched = await sessions.touch(entry.id);

    assert.ok(touched.lastActiveAt > original, 'lastActiveAt should be newer');
  });

  test('setFolder() changes folderId', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/f', workspace: 'ws-1' });
    const updated = await sessions.setFolder(entry.id, 'folder-abc');
    assert.equal(updated.folderId, 'folder-abc');

    const cleared = await sessions.setFolder(entry.id, null);
    assert.equal(cleared.folderId, null);
  });

  test('setTitle() changes title', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/t', workspace: 'ws-1' });
    const updated = await sessions.setTitle(entry.id, 'Hello World');
    assert.equal(updated.title, 'Hello World');

    const cleared = await sessions.setTitle(entry.id, '');
    assert.equal(cleared.title, '');
  });

  test('setCliSessionId() persists upstream session id', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/sid', workspace: 'ws-1' });
    const updated = await sessions.setCliSessionId(entry.id, 'abc-123-def');
    assert.equal(updated.cliSessionId, 'abc-123-def');

    const cleared = await sessions.setCliSessionId(entry.id, null);
    assert.equal(cleared.cliSessionId, null);
  });
});

describe('persistedSessions · findByCliAndCwd', () => {
  test('findByCliAndCwd() finds matching session', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/match', workspace: 'ws-1' });
    const found = await sessions.findByCliAndCwd('claude', '/match');
    assert.equal(found.id, entry.id);
    assert.equal(found.cliId, entry.cliId);

    const notFound = await sessions.findByCliAndCwd('codex', '/match');
    assert.equal(notFound, null);
  });

  test('findBestByCliAndCwd() prefers running sessions', async () => {
    const e1 = await sessions.create({ cliId: 'claude', cwd: '/best', workspace: 'ws-1' });
    const e2 = await sessions.create({ cliId: 'claude', cwd: '/best', workspace: 'ws-1' });
    await sessions.markExited(e1.id, 0);

    const best = await sessions.findBestByCliAndCwd('claude', '/best');
    assert.equal(best.id, e2.id); // e2 is still running
  });
});

describe('persistedSessions · expiration', () => {
  test('expired deleted sessions are pruned from loadAll', async () => {
    const entry = await sessions.create({ cliId: 'claude', cwd: '/exp', workspace: 'ws-1' });
    await sessions.remove(entry.id);

    // After remove(), update() won't touch deleted entries.
    // Directly overwrite the file to simulate a very old deletedAt.
    const raw = await fsp.readFile(sessions.FILE, 'utf8');
    const list = JSON.parse(raw);
    const idx = list.findIndex((s) => s.id === entry.id);
    list[idx].deletedAt = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    const { atomicWriteJson } = require('../lib/atomicJson');
    await atomicWriteJson(sessions.FILE, list);

    // After manual override, both loadAll and loadDeleted should prune it.
    const all = await sessions.loadAll();
    assert.equal(all.find((s) => s.id === entry.id), undefined);

    const deleted = await sessions.loadDeleted();
    assert.equal(deleted.find((s) => s.id === entry.id), undefined);
  });
});

describe('persistedSessions · concurrent safety', () => {
  test('concurrent create() calls produce unique ids', async () => {
    const entries = await Promise.all(
      Array.from({ length: 10 }, () =>
        sessions.create({ cliId: 'claude', cwd: '/concurrent', workspace: 'ws-1' })
      )
    );

    const ids = entries.map((e) => e.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, 10);

    const all = await sessions.loadAll();
    const ours = all.filter((s) => s.cwd === '/concurrent');
    assert.equal(ours.length, 10);
  });
});

describe('persistedSessions · normalizeStore', () => {
  test('normalizeStore() returns non-deleted entries', async () => {
    const e1 = await sessions.create({ cliId: 'claude', cwd: '/norm1', workspace: 'ws-1' });
    const e2 = await sessions.create({ cliId: 'claude', cwd: '/norm2', workspace: 'ws-1' });
    await sessions.remove(e2.id);

    const norm = await sessions.normalizeStore();
    assert.ok(norm.find((s) => s.id === e1.id));
    assert.equal(norm.find((s) => s.id === e2.id), undefined);
  });
});
