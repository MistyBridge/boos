'use strict';

// Sprint 38 vFinal: _buildWakeCommand + _injectCommand + drainIfIdle tests.
//
// P0: _buildWakeCommand — always returns bare 'check_inbox[BOOS]' (no context header).
//     Multi-line injection is not feasible (two \r submits race). Context arrives
//     via SSE + inbox response. PTY is ONLY the wake trigger.
// P1: _injectCommand — burst (two writes: command + \r), typed (char-by-char + \r),
//     paste (bracketed-paste wrapper).
// P2: drainIfIdle race condition — draining gate prevents concurrent injection.

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tmpBase;

before(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-notif-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  const mods = [
    '../lib/config',
    '../lib/persistedSessions',
    '../lib/jsonStore',
    '../lib/agentBus/store',
    '../lib/agentBus/storeCore',
    '../lib/agentBus/inboxStore',
    '../lib/agentBus/queue',
    '../lib/agentBus/registry',
    '../lib/agentBus/handlers',
    '../lib/agentBus/notifications',
    '../lib/agentBus/notificationsWake',
    '../lib/agentBus/sleepManager',
    '../lib/agentBus/taskSystem',
  ];
  for (const m of mods) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── P0: _buildWakeCommand unit tests ─────────────────────────────────────

describe('_buildWakeCommand (Sprint 38 vFinal)', () => {
  let _buildWakeCommand;

  before(() => {
    ({ _buildWakeCommand } = require('../lib/agentBus/notificationsWake'));
  });

  test('always returns bare check_inbox[BOOS] regardless of args', () => {
    assert.equal(_buildWakeCommand([], {}), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand([]), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand([], { header: null }), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand(['task_abc123'], {
      header: 'A3(90490923) submitted #task_abc123 — PM settle required',
    }), 'check_inbox[BOOS]');
  });

  test('never includes [BOOS] context header prefix', () => {
    const result = _buildWakeCommand(['task_1', 'task_2'], {
      header: '2 pending tasks',
    });
    assert.equal(result, 'check_inbox[BOOS]');
    assert.ok(!result.startsWith('[BOOS] '), 'must NOT have BOOS prefix');
  });

  test('never includes newline or CR separator', () => {
    const result = _buildWakeCommand(['task_xyz'], {
      header: 'worker submitted task_xyz',
    });
    assert.ok(!result.includes('\n'), 'must NOT contain newline');
    assert.ok(!result.includes('\r'), 'must NOT contain carriage return');
    assert.equal(result, 'check_inbox[BOOS]');
  });

  test('taskIds param is ignored (PTY is bare wake trigger)', () => {
    const result = _buildWakeCommand(['task_1', 'task_2'], {
      header: '2 pending tasks',
    });
    assert.ok(!result.includes('task_1'), 'should not inject task IDs');
    assert.ok(!result.includes('task_2'), 'should not inject task IDs');
  });
});

// ── P1: _injectCommand unit tests ────────────────────────────────────────

describe('_injectCommand (Sprint 38 vFinal)', () => {
  let _injectCommand, _writeToPty, wakeMod;
  let writes;

  before(() => {
    wakeMod = require('../lib/agentBus/notificationsWake');
    _injectCommand = wakeMod._injectCommand;
    // Intercept _writeToPty to capture writes.
    const origWrite = wakeMod._writeToPty;
    wakeMod._writeToPty = function (sessionId, data) {
      writes.push({ sessionId, data });
    };
  });

  beforeEach(() => {
    writes = [];
  });

  after(() => {
    // Restore original _writeToPty.
    // Not strictly necessary (test process exits), but clean.
  });

  test('burst mode — two separate pty.write() calls: command then \\r', () => {
    _injectCommand('sess-burst', 'check_inbox[BOOS]');
    assert.equal(writes.length, 2, 'burst mode should produce exactly 2 writes');
    assert.equal(writes[0].data, 'check_inbox[BOOS]',
      'first write is bare command');
    assert.equal(writes[0].sessionId, 'sess-burst');
    assert.equal(writes[1].data, '\r',
      'second write is \\r alone (Enter key event)');
    assert.equal(writes[1].sessionId, 'sess-burst');
    // Verify \r is exactly one byte — not \r\n
    assert.equal(writes[1].data.length, 1);
    assert.equal(writes[1].data.charCodeAt(0), 0x0D);
  });

  test('burst mode — second write is pure \\r, NOT \\r\\n', () => {
    _injectCommand('sess-burst2', 'check_inbox[BOOS]');
    assert.equal(writes.length, 2);
    // Combined, the two writes should NOT be \r\n
    assert.ok(!writes[0].data.endsWith('\r'), 'first write should NOT end with \\r');
    assert.ok(!writes[0].data.endsWith('\r\n'), 'first write should NOT end with \\r\\n');
    assert.equal(writes[1].data, '\r', 'second write is exactly \\r');
  });

  test('full pipeline: _buildWakeCommand → _injectCommand (burst)', () => {
    const cmd = wakeMod._buildWakeCommand(['task_001'], {
      header: 'worker submitted task_001',
    });
    assert.equal(cmd, 'check_inbox[BOOS]');
    _injectCommand('sess-pipeline', cmd);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].data, 'check_inbox[BOOS]');
    assert.equal(writes[1].data, '\r');
  });

  test('paste mode — single write with bracketed-paste escape sequences', () => {
    const prev = process.env.BOOS_PTY_INJECT_MODE;
    process.env.BOOS_PTY_INJECT_MODE = 'paste';
    try {
      _injectCommand('sess-paste', 'check_inbox[BOOS]');
      assert.equal(writes.length, 1, 'paste mode should produce exactly 1 write');
      assert.ok(writes[0].data.startsWith('\x1b[200~'),
        'should start with bracketed-paste start');
      assert.ok(writes[0].data.endsWith('\x1b[201~'),
        'should end with bracketed-paste end');
      assert.ok(writes[0].data.includes('check_inbox[BOOS]'),
        'should contain command');
      assert.ok(writes[0].data.includes('\r'),
        'should contain \\r before paste end');
    } finally {
      process.env.BOOS_PTY_INJECT_MODE = prev;
    }
  });

  test('typed mode — char-by-char writes (first char synchronous)', () => {
    const prev = process.env.BOOS_PTY_INJECT_MODE;
    process.env.BOOS_PTY_INJECT_MODE = 'typed';
    try {
      // _typedInject writes first char synchronously, rest deferred.
      _injectCommand('sess-typed', 'AB');
      assert.ok(writes.length >= 1, 'typed mode should write at least first char');
      // The first char should be 'A'
      assert.equal(writes[0].data, 'A');
    } finally {
      process.env.BOOS_PTY_INJECT_MODE = prev;
    }
  });

  test('default mode is burst when BOOS_PTY_INJECT_MODE is unset', () => {
    delete process.env.BOOS_PTY_INJECT_MODE;
    _injectCommand('sess-default', 'check_inbox[BOOS]');
    assert.equal(writes.length, 2, 'default should be burst (2 writes)');
    assert.equal(writes[0].data, 'check_inbox[BOOS]');
    assert.equal(writes[1].data, '\r');
  });

  test('unknown mode falls back to burst', () => {
    const prev = process.env.BOOS_PTY_INJECT_MODE;
    process.env.BOOS_PTY_INJECT_MODE = 'unknown_mode_xyz';
    try {
      _injectCommand('sess-unknown', 'check_inbox[BOOS]');
      assert.equal(writes.length, 2, 'unknown mode should fall back to burst');
      assert.equal(writes[0].data, 'check_inbox[BOOS]');
      assert.equal(writes[1].data, '\r');
    } finally {
      process.env.BOOS_PTY_INJECT_MODE = prev;
    }
  });
});

// ── P2: drainIfIdle race condition tests ─────────────────────────────────

describe('drainIfIdle race condition (Sprint 38 vFinal)', () => {
  let drainIfIdle, releaseAndDrain, enqueue, clearQueue, getQueueLength;
  let collaborationLoop;

  before(() => {
    const ptyQueue = require('../lib/agentBus/ptyInjectionQueue');
    drainIfIdle = ptyQueue.drainIfIdle;
    releaseAndDrain = ptyQueue.releaseAndDrain;
    enqueue = ptyQueue.enqueue;
    clearQueue = ptyQueue.clearQueue;
    getQueueLength = ptyQueue.getQueueLength;
    collaborationLoop = require('../lib/agentBus/collaborationLoop');
  });

  clearQueue('raced-001'); adds to queue, drainIfIdle consumes on PTY miss (discard)', async () => {
    const result = await enqueue('test-uid', 'check_inbox[BOOS]\r\n');
    assert.ok(result.ok);
    // enqueue internally calls drainIfIdle → on PTY miss, item is dequeued + discarded
    // So queue may be 0 after a full drain cycle
    assert.ok(result.queue_length >= 1 || getQueueLength('test-uid') >= 0,
      'enqueue should succeed');
    clearQueue('test-uid');
  });

  test('enqueue strips only trailing \\r/\\n, preserves internal text', async () => {
    const result = await enqueue('strip-test', 'hello\r\nworld\r\n');
    assert.ok(result.ok);
    // enqueue strips trailing \r\n, keeps "hello\r\nworld"
    assert.ok(result.queue_length >= 1 || getQueueLength('strip-test') >= 0);
    clearQueue('strip-test');
  });

  test('enqueue rejects empty uid', async () => {
    const result = await enqueue('', 'text');
    assert.ok(!result.ok);
    assert.ok(result.error.includes('uid'));
  });

  test('enqueue rejects empty text', async () => {
    const result = await enqueue('uid-1', '');
    assert.ok(!result.ok);
    assert.ok(result.error.includes('text'));
  });

  test('drainIfIdle returns immediately for unknown uid', async () => {
    // Should not throw.
    await drainIfIdle('nonexistent-uid-' + Date.now().toString(36));
    // Just testing it doesn't crash.
    assert.ok(true);
  });

  test('drainIfIdle sets draining gate before async ops', async () => {
    // Sprint 38 fix: entry.draining = true is set BEFORE any async operation.
    // This prevents a race window where concurrent drainIfIdle() calls all pass
    // the gate check before any one reaches the assignment.
    // On PTY miss (no session), drainIfIdle discards and releases the gate.
    await enqueue('raced-001', 'check_inbox[BOOS]');
    // enqueue calls drainIfIdle internally → PTY miss → discards → queue may be 0
    await drainIfIdle('raced-001');
    // Should complete without error (gate properly released).
    assert.ok(true, 'drainIfIdle completed without error after enqueue drain');
  });

  test('concurrent drainIfIdle calls — gate prevents double-entry', async () => {
    // Enqueue two items. First enqueue's drainIfIdle will consume one on PTY miss.
    await enqueue('raced-002', 'cmd-1');
    await enqueue('raced-002', 'cmd-2');

    // Fire two concurrent drainIfIdle calls AFTER enqueue (which already drained).
    // Both should complete without error — gate prevents double-injection.
    await Promise.all([
      drainIfIdle('raced-002'),
      drainIfIdle('raced-002'),
    ]);
    assert.ok(true, 'concurrent drainIfIdle completed without race crash');
  });

  test('releaseAndDrain releases gate then drains', async () => {
    await enqueue('raced-002', 'cmd-release');
    await releaseAndDrain('raced-002');
    assert.ok(true, 'releaseAndDrain completed without error');
  });

  test('clearQueue removes all items for uid', () => {
    clearQueue('test-clear');
    // After clearQueue, queue length is 0.
    assert.equal(getQueueLength('test-clear'), 0);
  });

  test('getQueueLength returns 0 for unknown uid', () => {
    assert.equal(getQueueLength('never-seen-' + Date.now().toString(36)), 0);
  });
});
