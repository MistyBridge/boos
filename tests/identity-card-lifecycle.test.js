'use strict';

// Sprint 20 regression: identity card lifecycle.
// Tests that identity cards are the reliable single source of truth for
// agent→session binding: auto-resolve, link, exit, and __pending__ healing.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tmpBase;

before(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-idcard-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  for (const m of ['../lib/config', '../lib/agentBus/store', '../lib/agentBus/queue',
    '../lib/agentBus/registry', '../lib/agentBus/handlers']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

describe('Identity card lifecycle (Sprint 20)', () => {
  test('linkIdentityToSession sets boos_session_id + reverse index', async () => {
    const registry = require('../lib/agentBus/registry');
    const store = require('../lib/agentBus/store');

    const r = await registry.registerAgent({
      name: 'idcard-test-agent', intro: 'test', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
    });

    // Before link: no identity.
    let ident = store.getIdentity({ uid: r.uid });
    assert.equal(ident, null, 'no identity before upsert');

    // Register path: set name metadata.
    await store.upsertIdentity(r.uid, {
      name: 'idcard-test-agent', workspace: 'boos', role: 'worker',
      mcp_session_id: 'mcp-test-123',
      boos_session_id: '__pending__', cwd: '__pending__', pty_pid: 0,
    });

    // Link to session.
    await store.linkIdentityToSession(r.uid, 'sess-test-abc', '/home/test', 4242);

    ident = store.getIdentity({ uid: r.uid });
    assert.equal(ident.boos_session_id, 'sess-test-abc', 'boos_session_id should be updated');
    assert.equal(ident.cwd, '/home/test', 'cwd should be updated');
    assert.equal(ident.pty_pid, 4242, 'pty_pid should be updated');

    // Reverse index.
    const bySession = store.getIdentityByBoosSession('sess-test-abc');
    assert.ok(bySession, 'reverse index should resolve by boos session');
    assert.equal(bySession.agent_uid, r.uid);
  });

  test('onSessionExited clears pty_pid but keeps link', async () => {
    const registry = require('../lib/agentBus/registry');
    const store = require('../lib/agentBus/store');

    const r = await registry.registerAgent({
      name: 'idcard-exit-agent', intro: 'test', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
    });

    await store.upsertIdentity(r.uid, {
      name: 'idcard-exit-agent', workspace: 'boos', role: 'worker',
      mcp_session_id: 'mcp-exit-456',
      boos_session_id: '__pending__', cwd: '__pending__', pty_pid: 0,
    });
    await store.linkIdentityToSession(r.uid, 'sess-exit-xyz', '/home/exit', 9999);

    // Exit: pty_pid reset to 0, boos_session_id preserved.
    await store.onSessionExited('sess-exit-xyz');

    const ident = store.getIdentity({ uid: r.uid });
    assert.equal(ident.pty_pid, 0, 'pty_pid should be cleared on exit');
    assert.equal(ident.boos_session_id, 'sess-exit-xyz', 'boos_session_id should be preserved');
    assert.equal(ident.cwd, '/home/exit', 'cwd should be preserved');
  });

  test('autoResolveIdentity finds agent from MCP session', async () => {
    const registry = require('../lib/agentBus/registry');
    const store = require('../lib/agentBus/store');

    const r = await registry.registerAgent({
      name: 'idcard-auto-agent', intro: 'test', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
    });

    // Simulate register path: MCP session binding + identity card.
    await store.bindMcpSession('mcp-auto-789', r.uid);
    await store.upsertIdentity(r.uid, {
      name: 'idcard-auto-agent', workspace: 'boos', role: 'worker',
      mcp_session_id: 'mcp-auto-789',
      boos_session_id: '__pending__', cwd: '__pending__', pty_pid: 0,
    });

    // Auto-resolve by MCP session ID.
    const auto = store.autoResolveIdentity('mcp-auto-789');
    assert.ok(auto, 'should resolve identity from MCP session');
    assert.equal(auto.uid, r.uid);
    assert.equal(auto.identity.name, 'idcard-auto-agent');
  });

  test('autoResolveIdentity returns null for unknown session', () => {
    const store = require('../lib/agentBus/store');
    const auto = store.autoResolveIdentity('mcp-nonexistent');
    assert.equal(auto, null, 'should return null for unknown MCP session');
  });

  test('dispatch auto-registers caller with known MCP session', async () => {
    const registry = require('../lib/agentBus/registry');
    const store = require('../lib/agentBus/store');
    const { dispatch } = require('../lib/agentBus/handlers');

    const r = await registry.registerAgent({
      name: 'idcard-dispatch-agent', intro: 'test', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
    });

    // Set up identity with MCP session binding.
    await store.bindMcpSession('mcp-dispatch-10', r.uid);
    await store.upsertIdentity(r.uid, {
      name: 'idcard-dispatch-agent', workspace: 'boos', role: 'worker',
      mcp_session_id: 'mcp-dispatch-10',
      boos_session_id: '__pending__', cwd: '__pending__', pty_pid: 0,
    });

    // Call dispatch WITHOUT ctx.uid (simulating unregistered MCP caller).
    // auto-registration should derive identity from ctx.sessionId.
    const ctx = { sessionId: 'mcp-dispatch-10', uid: null, workspace: null };
    const result = await dispatch('list_my_tasks', {}, ctx);

    // Should succeed — auto-registration filled ctx.uid.
    assert.ok('tasks' in result, 'should return tasks array, not error: ' + JSON.stringify(result));
    assert.ok(Array.isArray(result.tasks), 'tasks should be an array');
  });

  test('dispatch rejects truly unknown caller', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const ctx = { sessionId: 'mcp-total-rando', uid: null, workspace: null };
    const result = await dispatch('list_my_tasks', {}, ctx);
    assert.ok(result.error, 'should reject unknown caller: ' + JSON.stringify(result));
  });
});
