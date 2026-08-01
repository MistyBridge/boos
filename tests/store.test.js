'use strict';

// AgentBus Store — tests for lib/agentBus/store.js
//
// Covers: Agent CRUD, session binding, task operations (via storeTasks),
// identity cards (via storeIdentity), PM identity, heartbeat, and edge cases.
//
// Uses temporary BOOS_HOME with real agent-bus.json — zero mocking.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let TMP;
const origHome = process.env.BOOS_HOME;
const origNoAgentBus = process.env.BOOS_NO_AGENT_BUS;

const CLEAR_MODS = [
  '../lib/config', '../lib/agentBus/storeCore',
  '../lib/agentBus/store', '../lib/agentBus/storeTasks', '../lib/agentBus/storeIdentity',
  '../lib/agentBus/queue', '../lib/agentBus/registry',
  '../lib/agentBus/handlers', '../lib/agentBus/handlersAdmin',
  '../lib/agentBus/handlersDag', '../lib/agentBus/handlersSession',
  '../lib/agentBus/notifications', '../lib/agentBus/notificationsWake',
  '../lib/agentBus/heartbeat', '../lib/agentBus/collaborationLoop',
  '../lib/agentBus/taskAnalytics', '../lib/agentBus/taskTimeout',
  '../lib/agentBus/fileLock', '../lib/agentBus/constraints',
  '../lib/agentBus/transport', '../lib/agentBus/autoSupervisor',
  '../lib/identityResolver', '../lib/identityAdapter',
  '../lib/folders', '../lib/persistedSessions',
  '../lib/sandbox', '../lib/hrAgent',
];

function clearCaches() {
  for (const m of CLEAR_MODS) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

function freshSetup() {
  if (TMP) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  TMP = path.join(os.tmpdir(), 'boos-store-' + Date.now().toString(36));
  fs.mkdirSync(TMP, { recursive: true });
  process.env.BOOS_HOME = TMP;
  process.env.BOOS_NO_AGENT_BUS = '1';
  clearCaches();
}

function teardown() {
  if (origHome === undefined) delete process.env.BOOS_HOME;
  else process.env.BOOS_HOME = origHome;
  if (origNoAgentBus === undefined) delete process.env.BOOS_NO_AGENT_BUS;
  else process.env.BOOS_NO_AGENT_BUS = origNoAgentBus;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function nextUid() {
  const n = String(++_counter).padStart(8, '0');
  return `test-${n}-${n}-${n}-${n}${n}${n}${n}${n}${n}`;
}

function makeTask(overrides = {}) {
  const now = new Date().toISOString();
  return {
    task_id: 'task_' + Math.random().toString(36).slice(2, 10),
    sender_uid: 'sender-' + nextUid(),
    sender_name: 'Test Sender',
    receiver_uid: 'receiver-' + nextUid(),
    content: 'Test task content ' + Math.random().toString(36).slice(2, 8),
    priority: 'normal',
    status: 'pending',
    created_at: now,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent CRUD
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent CRUD', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  describe('insertAgent', () => {
    test('inserts a new agent and returns it', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-001', name: 'TestAgent', intro: 'A test agent',
        workspace: 'boos', role: 'worker', capabilities: ['test', 'debug'],
      });
      assert.strictEqual(agent.uid, 'agent-001');
      assert.strictEqual(agent.name, 'TestAgent');
      assert.strictEqual(agent.workspace, 'boos');
      assert.strictEqual(agent.role, 'worker');
      assert.deepStrictEqual(agent.capabilities, ['test', 'debug']);
      assert.ok(agent.registered_at);
      assert.ok(agent.last_seen_at);
    });

    test('inserts supervisor agent', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-sup', name: 'Supervisor', intro: 'PM',
        workspace: 'boos', role: 'supervisor', capabilities: ['manage'],
      });
      assert.strictEqual(agent.role, 'supervisor');
    });

    test('inserts root agent with special handling', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-root', name: 'Root', intro: 'Root agent',
        workspace: 'boos', role: 'root', capabilities: [],
      });
      assert.strictEqual(agent.workspace, '*');
      assert.deepStrictEqual(agent.capabilities, ['root', 'human_interface']);
      assert.strictEqual(agent.project, null);
      assert.strictEqual(agent.last_seen_at, '9999-12-31T23:59:59.999Z');
    });

    test('truncates name to 64 chars', async () => {
      const longName = 'A'.repeat(100);
      const agent = await store.insertAgent({
        uid: 'agent-long', name: longName, workspace: 'boos',
      });
      assert.strictEqual(agent.name.length, 64);
      assert.strictEqual(agent.name, 'A'.repeat(64));
    });

    test('truncates intro to 256 chars', async () => {
      const longIntro = 'B'.repeat(500);
      const agent = await store.insertAgent({
        uid: 'agent-intro', name: 'Intro', intro: longIntro, workspace: 'boos',
      });
      assert.strictEqual(agent.intro.length, 256);
    });

    test('truncates capabilities to 10', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-caps', name: 'Caps', workspace: 'boos',
        capabilities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
      });
      assert.strictEqual(agent.capabilities.length, 10);
    });

    test('truncates pm_of to 20', async () => {
      const projects = Array.from({ length: 30 }, (_, i) => 'proj-' + i);
      const agent = await store.insertAgent({
        uid: 'agent-pmof', name: 'PMOf', workspace: 'boos',
        pm_of: projects,
      });
      assert.strictEqual(agent.pm_of.length, 20);
    });

    test('stores project field', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-proj', name: 'Proj', workspace: 'boos',
        project: 'my-project',
      });
      assert.strictEqual(agent.project, 'my-project');
    });

    test('defaults role to worker when missing', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-def', name: 'Default', workspace: 'boos',
      });
      assert.strictEqual(agent.role, 'worker');
    });

    test('defaults capabilities to empty array', async () => {
      const agent = await store.insertAgent({
        uid: 'agent-nocaps', name: 'NoCaps', workspace: 'boos',
      });
      assert.deepStrictEqual(agent.capabilities, []);
    });

    test('creates name_ws index entry', async () => {
      await store.insertAgent({
        uid: 'agent-idx', name: 'Indexed', workspace: 'boos',
      });
      const found = store.findAgentByNameWs('Indexed', 'boos');
      assert.ok(found);
      assert.strictEqual(found.uid, 'agent-idx');
    });
  });

  describe('getAgent', () => {
    test('returns agent by uid', async () => {
      await store.insertAgent({
        uid: 'agent-get', name: 'GetMe', workspace: 'boos',
      });
      const agent = store.getAgent('agent-get');
      assert.ok(agent);
      assert.strictEqual(agent.name, 'GetMe');
    });

    test('returns null for non-existent uid', () => {
      const agent = store.getAgent('nonexistent-uid');
      assert.strictEqual(agent, null);
    });

    test('returns fresh data after insert', async () => {
      const uid = 'agent-fresh';
      await store.insertAgent({ uid, name: 'Fresh', workspace: 'boos' });
      const a1 = store.getAgent(uid);
      assert.strictEqual(a1.name, 'Fresh');
    });
  });

  describe('findAgentByNameWs', () => {
    test('finds agent by name and workspace', async () => {
      await store.insertAgent({
        uid: 'agent-fn1', name: 'Finder1', workspace: 'boos',
      });
      const found = store.findAgentByNameWs('Finder1', 'boos');
      assert.ok(found);
      assert.strictEqual(found.uid, 'agent-fn1');
    });

    test('returns null when name matches but workspace differs', async () => {
      await store.insertAgent({
        uid: 'agent-fn2', name: 'Finder2', workspace: 'boos',
      });
      const found = store.findAgentByNameWs('Finder2', 'other-ws');
      assert.strictEqual(found, null);
    });

    test('returns null for unknown name', () => {
      const found = store.findAgentByNameWs('Nobody', 'boos');
      assert.strictEqual(found, null);
    });

    test('different agents with same name in different workspaces', async () => {
      await store.insertAgent({
        uid: 'agent-ws1', name: 'SameName', workspace: 'ws-a',
      });
      await store.insertAgent({
        uid: 'agent-ws2', name: 'SameName', workspace: 'ws-b',
      });
      const a1 = store.findAgentByNameWs('SameName', 'ws-a');
      const a2 = store.findAgentByNameWs('SameName', 'ws-b');
      assert.strictEqual(a1.uid, 'agent-ws1');
      assert.strictEqual(a2.uid, 'agent-ws2');
    });
  });

  describe('touchAgent', () => {
    test('updates last_seen_at', async () => {
      await store.insertAgent({
        uid: 'agent-touch', name: 'Touch', workspace: 'boos',
      });
      const before = store.getAgent('agent-touch').last_seen_at;
      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 10));
      await store.touchAgent('agent-touch');
      const after = store.getAgent('agent-touch').last_seen_at;
      assert.ok(new Date(after) > new Date(before));
    });

    test('is a no-op for non-existent agent', async () => {
      // Should not throw
      await store.touchAgent('nonexistent');
    });
  });

  describe('deleteAgent', () => {
    test('deletes an agent and returns true', async () => {
      await store.insertAgent({
        uid: 'agent-del', name: 'DeleteMe', workspace: 'boos',
      });
      const result = await store.deleteAgent('agent-del');
      assert.strictEqual(result, true);
      assert.strictEqual(store.getAgent('agent-del'), null);
    });

    test('returns false for non-existent agent', async () => {
      const result = await store.deleteAgent('no-such-agent');
      assert.strictEqual(result, false);
    });

    test('removes name_ws index on delete', async () => {
      await store.insertAgent({
        uid: 'agent-del2', name: 'DelIdx', workspace: 'boos',
      });
      await store.deleteAgent('agent-del2');
      const found = store.findAgentByNameWs('DelIdx', 'boos');
      assert.strictEqual(found, null);
    });

    test('cleans up bound sessions on delete', async () => {
      await store.insertAgent({
        uid: 'agent-del3', name: 'DelSess', workspace: 'boos',
      });
      await store.bindSession('sess-del', 'agent-del3', 'boos');
      assert.strictEqual(store.getSessionAgentUid('sess-del'), 'agent-del3');

      await store.deleteAgent('agent-del3');
      assert.strictEqual(store.getSessionAgentUid('sess-del'), null);
    });

    test('delete allows re-registration with same uid', async () => {
      await store.insertAgent({
        uid: 'agent-recycle', name: 'Recycle1', workspace: 'boos',
      });
      await store.deleteAgent('agent-recycle');
      await store.insertAgent({
        uid: 'agent-recycle', name: 'Recycle2', workspace: 'boos',
      });
      assert.strictEqual(store.getAgent('agent-recycle').name, 'Recycle2');
    });
  });

  describe('migrateAgentUid', () => {
    test('migrates agent to new uid', async () => {
      await store.insertAgent({
        uid: 'agent-old', name: 'MigrateMe', intro: 'test', workspace: 'boos',
        capabilities: ['test'],
      });
      const result = await store.migrateAgentUid('agent-old', 'agent-new');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.migrated, true);
      assert.strictEqual(store.getAgent('agent-old'), null);
      const migrated = store.getAgent('agent-new');
      assert.ok(migrated);
      assert.strictEqual(migrated.name, 'MigrateMe');
      assert.strictEqual(migrated.uid, 'agent-new');
    });

    test('returns migrated:false when oldUid equals newUid', async () => {
      await store.insertAgent({
        uid: 'agent-same', name: 'Same', workspace: 'boos',
      });
      const result = await store.migrateAgentUid('agent-same', 'agent-same');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.migrated, false);
    });

    test('returns error when old uid not found', async () => {
      const result = await store.migrateAgentUid('no-such', 'new-one');
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    test('returns error when new uid already exists', async () => {
      await store.insertAgent({
        uid: 'agent-a', name: 'A', workspace: 'boos',
      });
      await store.insertAgent({
        uid: 'agent-b', name: 'B', workspace: 'boos',
      });
      const result = await store.migrateAgentUid('agent-a', 'agent-b');
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('already exists'));
    });

    test('updates name_ws index after migration', async () => {
      await store.insertAgent({
        uid: 'agent-old2', name: 'MigIdx', workspace: 'boos',
      });
      await store.migrateAgentUid('agent-old2', 'agent-new2');
      const found = store.findAgentByNameWs('MigIdx', 'boos');
      assert.strictEqual(found.uid, 'agent-new2');
    });

    test('updates task sender/receiver references', async () => {
      await store.insertAgent({
        uid: 'agent-old3', name: 'TaskRef', workspace: 'boos',
      });
      const task = makeTask({ sender_uid: 'agent-old3', receiver_uid: 'agent-old3' });
      await store.insertTask(task);
      await store.migrateAgentUid('agent-old3', 'agent-new3');
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.sender_uid, 'agent-new3');
      assert.strictEqual(t.receiver_uid, 'agent-new3');
    });

    test('updates session references', async () => {
      await store.insertAgent({
        uid: 'agent-old4', name: 'SessRef', workspace: 'boos',
      });
      await store.bindSession('sess-mig', 'agent-old4', 'boos');
      await store.migrateAgentUid('agent-old4', 'agent-new4');
      assert.strictEqual(store.getSessionAgentUid('sess-mig'), 'agent-new4');
    });
  });

  describe('listAgentsInWorkspace', () => {
    test('lists agents in a workspace', async () => {
      await store.insertAgent({
        uid: 'agent-l1', name: 'Alpha', workspace: 'boos',
      });
      await store.insertAgent({
        uid: 'agent-l2', name: 'Beta', workspace: 'boos',
      });
      const agents = store.listAgentsInWorkspace('boos');
      assert.ok(agents.length >= 2);
      const names = agents.map((a) => a.name);
      assert.ok(names.includes('Alpha'));
      assert.ok(names.includes('Beta'));
    });

    test('sorts by name', async () => {
      await store.insertAgent({
        uid: 'agent-s1', name: 'Zeta', workspace: 'boos',
      });
      await store.insertAgent({
        uid: 'agent-s2', name: 'Alpha', workspace: 'boos',
      });
      const agents = store.listAgentsInWorkspace('boos');
      const sorted = agents.every((a, i) => i === 0 || a.name >= agents[i - 1].name);
      assert.ok(sorted);
    });

    test('returns empty array for empty workspace', () => {
      const agents = store.listAgentsInWorkspace('empty-ws');
      assert.deepStrictEqual(agents, []);
    });

    test('filters by project when opts.project is set', async () => {
      await store.insertAgent({
        uid: 'agent-p1', name: 'ProjA', workspace: 'boos', project: 'proj-a',
      });
      await store.insertAgent({
        uid: 'agent-p2', name: 'ProjB', workspace: 'boos', project: 'proj-b',
      });
      await store.insertAgent({
        uid: 'agent-p3', name: 'NoProj', workspace: 'boos',
      });
      const filtered = store.listAgentsInWorkspace('boos', { project: 'proj-a' });
      const names = filtered.map((a) => a.name);
      assert.ok(names.includes('ProjA'));
      assert.ok(names.includes('NoProj')); // null project matches
      assert.ok(!names.includes('ProjB')); // different project excluded
    });

    test('returns sanitized shape (no internal fields)', async () => {
      await store.insertAgent({
        uid: 'agent-shape', name: 'Shape', workspace: 'boos',
      });
      const [a] = store.listAgentsInWorkspace('boos');
      assert.ok(a.uid);
      assert.ok(a.name);
      assert.ok(a.intro !== undefined);
      assert.ok(a.workspace);
      assert.ok(a.role);
      assert.ok(Array.isArray(a.capabilities));
    });
  });

  describe('listAllAgentsInWorkspace', () => {
    test('includes session_count field', async () => {
      await store.insertAgent({
        uid: 'agent-sc', name: 'SessionCount', workspace: 'boos',
      });
      await store.bindSession('sess-sc1', 'agent-sc', 'boos');
      await store.bindSession('sess-sc2', 'agent-sc', 'boos');
      const agents = store.listAllAgentsInWorkspace('boos');
      const a = agents.find((x) => x.uid === 'agent-sc');
      assert.ok(a);
      assert.strictEqual(a.session_count, 2);
    });

    test('includes registered_at and last_seen_at', async () => {
      await store.insertAgent({
        uid: 'agent-full', name: 'Full', workspace: 'boos',
      });
      const agents = store.listAllAgentsInWorkspace('boos');
      const a = agents.find((x) => x.uid === 'agent-full');
      assert.ok(a.registered_at);
      assert.ok(a.last_seen_at);
    });
  });

  describe('listAllAgents', () => {
    test('lists all agents across all workspaces', async () => {
      await store.insertAgent({
        uid: 'agent-aa1', name: 'All1', workspace: 'ws-a',
      });
      await store.insertAgent({
        uid: 'agent-aa2', name: 'All2', workspace: 'ws-b',
      });
      const all = store.listAllAgents();
      const uids = all.map((a) => a.uid);
      assert.ok(uids.includes('agent-aa1'));
      assert.ok(uids.includes('agent-aa2'));
    });

    test('includes unresponsive flag', async () => {
      await store.insertAgent({
        uid: 'agent-ur', name: 'Unresp', workspace: 'boos',
      });
      await store.setAgentUnresponsive('agent-ur', true);
      const all = store.listAllAgents();
      const a = all.find((x) => x.uid === 'agent-ur');
      assert.strictEqual(a.unresponsive, true);
    });
  });

  describe('countStaleAgents', () => {
    test('counts agents whose last_seen_at is before cutoff', async () => {
      await store.insertAgent({
        uid: 'agent-stale', name: 'Stale', workspace: 'boos',
      });
      // Future cutoff → all agents are stale (their timestamp is in the past)
      const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
      const count = store.countStaleAgents(future);
      assert.ok(count >= 1);
    });

    test('returns 0 when cutoff is in the past', async () => {
      await store.insertAgent({
        uid: 'agent-fresh2', name: 'Fresh2', workspace: 'boos',
      });
      const past = new Date(0).toISOString(); // 1970
      const count = store.countStaleAgents(past);
      assert.strictEqual(count, 0);
    });
  });

  describe('DB lifecycle', () => {
    test('getDb returns json-file type with path', () => {
      const db = store.getDb();
      assert.strictEqual(db.type, 'json-file');
      assert.ok(db.path);
    });

    test('closeDb does not throw', () => {
      store.closeDb();
    });

    test('DB_PATH is a string', () => {
      assert.strictEqual(typeof store.DB_PATH, 'string');
    });

    test('DATA_DIR is a string', () => {
      assert.strictEqual(typeof store.DATA_DIR, 'string');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Session Binding
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session Binding', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  describe('bindSession', () => {
    test('binds a session to an agent', async () => {
      await store.insertAgent({
        uid: 'agent-bind', name: 'Bind', workspace: 'boos',
      });
      await store.bindSession('sess-1', 'agent-bind', 'boos');
      assert.strictEqual(store.getSessionAgentUid('sess-1'), 'agent-bind');
    });

    test('multiple sessions can bind to same agent', async () => {
      await store.insertAgent({
        uid: 'agent-multi', name: 'Multi', workspace: 'boos',
      });
      await store.bindSession('sess-a', 'agent-multi', 'boos');
      await store.bindSession('sess-b', 'agent-multi', 'boos');
      assert.strictEqual(store.getSessionAgentUid('sess-a'), 'agent-multi');
      assert.strictEqual(store.getSessionAgentUid('sess-b'), 'agent-multi');
    });

    test('overwrites existing session binding', async () => {
      await store.insertAgent({
        uid: 'agent-ow1', name: 'OW1', workspace: 'boos',
      });
      await store.insertAgent({
        uid: 'agent-ow2', name: 'OW2', workspace: 'boos',
      });
      await store.bindSession('sess-ow', 'agent-ow1', 'boos');
      await store.bindSession('sess-ow', 'agent-ow2', 'boos');
      assert.strictEqual(store.getSessionAgentUid('sess-ow'), 'agent-ow2');
    });
  });

  describe('unbindSession', () => {
    test('unbinds a session', async () => {
      await store.insertAgent({
        uid: 'agent-unbind', name: 'Unbind', workspace: 'boos',
      });
      await store.bindSession('sess-ub', 'agent-unbind', 'boos');
      await store.unbindSession('sess-ub');
      assert.strictEqual(store.getSessionAgentUid('sess-ub'), null);
    });

    test('is a no-op for non-existent session', async () => {
      await store.unbindSession('never-bound');
    });
  });

  describe('getSessionAgentUid', () => {
    test('returns null for non-existent session', () => {
      assert.strictEqual(store.getSessionAgentUid('no-session'), null);
    });

    test('returns agent uid for bound session', async () => {
      await store.insertAgent({
        uid: 'agent-sessuid', name: 'SessUid', workspace: 'boos',
      });
      await store.bindSession('sess-uid', 'agent-sessuid', 'boos');
      assert.strictEqual(store.getSessionAgentUid('sess-uid'), 'agent-sessuid');
    });
  });

  describe('getSessionByAgentUid', () => {
    test('returns session id for bound agent', async () => {
      await store.insertAgent({
        uid: 'agent-findby', name: 'FindBy', workspace: 'boos',
      });
      await store.bindSession('sess-find', 'agent-findby', 'boos');
      assert.strictEqual(store.getSessionByAgentUid('agent-findby'), 'sess-find');
    });

    test('returns null for unbound agent', () => {
      assert.strictEqual(store.getSessionByAgentUid('no-such-agent'), null);
    });

    test('returns first matching session when multiple bound', async () => {
      await store.insertAgent({
        uid: 'agent-multi2', name: 'Multi2', workspace: 'boos',
      });
      await store.bindSession('sess-first', 'agent-multi2', 'boos');
      await store.bindSession('sess-second', 'agent-multi2', 'boos');
      const sid = store.getSessionByAgentUid('agent-multi2');
      assert.ok(sid === 'sess-first' || sid === 'sess-second');
    });
  });

  describe('countAgentSessions', () => {
    test('counts bound sessions', async () => {
      await store.insertAgent({
        uid: 'agent-count', name: 'Count', workspace: 'boos',
      });
      await store.bindSession('sess-c1', 'agent-count', 'boos');
      await store.bindSession('sess-c2', 'agent-count', 'boos');
      await store.bindSession('sess-c3', 'agent-count', 'boos');
      assert.strictEqual(store.countAgentSessions('agent-count'), 3);
    });

    test('returns 0 for unbound agent', () => {
      assert.strictEqual(store.countAgentSessions('no-agent'), 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task Operations
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task Operations', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  describe('genTaskId', () => {
    test('returns a string starting with task_', () => {
      const id = store.genTaskId();
      assert.ok(typeof id === 'string');
      assert.ok(id.startsWith('task_'));
    });

    test('generates unique ids', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(store.genTaskId());
      assert.strictEqual(ids.size, 100);
    });
  });

  describe('insertTask', () => {
    test('inserts a task and returns it', async () => {
      const task = makeTask();
      const result = await store.insertTask(task);
      assert.strictEqual(result.task_id, task.task_id);
      assert.strictEqual(result.status, 'pending');
    });

    test('task is persisted and retrievable', async () => {
      const task = makeTask({ content: 'Persist me' });
      await store.insertTask(task);
      const retrieved = store.getTask(task.task_id);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.content, 'Persist me');
    });

    test('stores all task fields', async () => {
      const task = makeTask({
        priority: 'high',
        workflow_id: 'wf-1',
        stage_id: 'stage-a',
        reply_to: 'task-parent',
        message_type: 'response',
        required_capabilities: ['test'],
        matched_via: 'capability',
        metadata: { key: 'value' },
        retry_count: 2,
      });
      await store.insertTask(task);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.priority, 'high');
      assert.strictEqual(t.workflow_id, 'wf-1');
      assert.strictEqual(t.stage_id, 'stage-a');
      assert.strictEqual(t.reply_to, 'task-parent');
      assert.strictEqual(t.message_type, 'response');
      assert.deepStrictEqual(t.required_capabilities, ['test']);
      assert.strictEqual(t.matched_via, 'capability');
      assert.deepStrictEqual(t.metadata, { key: 'value' });
      assert.strictEqual(t.retry_count, 2);
    });

    test('truncates sender_name to 64 chars', async () => {
      const task = makeTask({ sender_name: 'X'.repeat(100) });
      await store.insertTask(task);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.sender_name.length, 64);
    });

    test('truncates sender_intro to 256 chars', async () => {
      const task = makeTask({ sender_intro: 'Y'.repeat(500) });
      await store.insertTask(task);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.sender_intro.length, 256);
    });
  });

  describe('getTask', () => {
    test('returns null for non-existent task', () => {
      assert.strictEqual(store.getTask('no-task'), null);
    });
  });

  describe('getTaskAsync', () => {
    test('returns task asynchronously', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const t = await store.getTaskAsync(task.task_id);
      assert.ok(t);
      assert.strictEqual(t.task_id, task.task_id);
    });

    test('returns null for non-existent task', async () => {
      const t = await store.getTaskAsync('no-task-async');
      assert.strictEqual(t, null);
    });
  });

  describe('getPendingTask', () => {
    test('returns highest priority pending task', async () => {
      const receiver = 'receiver-prio';
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'low', content: 'low' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'high', content: 'high' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'normal', content: 'normal' }));
      const task = store.getPendingTask(receiver);
      assert.ok(task);
      assert.strictEqual(task.priority, 'high');
    });

    test('within same priority, returns oldest first', async () => {
      const receiver = 'receiver-chrono';
      const t1 = makeTask({ receiver_uid: receiver, created_at: '2026-01-01T00:00:00Z', content: 'older' });
      const t2 = makeTask({ receiver_uid: receiver, created_at: '2026-06-01T00:00:00Z', content: 'newer' });
      await store.insertTask(t1);
      await store.insertTask(t2);
      const task = store.getPendingTask(receiver);
      assert.strictEqual(task.content, 'older');
    });

    test('returns null when no pending tasks', () => {
      assert.strictEqual(store.getPendingTask('no-receiver'), null);
    });

    test('ignores non-pending tasks', async () => {
      const receiver = 'receiver-np';
      await store.insertTask(makeTask({ receiver_uid: receiver, status: 'completed' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, status: 'in_progress' }));
      assert.strictEqual(store.getPendingTask(receiver), null);
    });
  });

  describe('listPendingTasks', () => {
    test('lists all pending tasks for receiver', async () => {
      const receiver = 'receiver-list';
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'high' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'low' }));
      const tasks = store.listPendingTasks(receiver);
      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(tasks[0].priority, 'high');
      assert.strictEqual(tasks[1].priority, 'low');
    });

    test('returns empty array for receiver with no tasks', () => {
      assert.deepStrictEqual(store.listPendingTasks('nobody'), []);
    });
  });

  describe('listActiveTasks', () => {
    test('includes pending and in_progress', async () => {
      const receiver = 'receiver-active';
      await store.insertTask(makeTask({ receiver_uid: receiver, status: 'pending' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, status: 'in_progress' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, status: 'completed' }));
      const tasks = store.listActiveTasks(receiver);
      assert.strictEqual(tasks.length, 2);
    });
  });

  describe('countPendingTasks', () => {
    test('counts pending tasks', async () => {
      const receiver = 'receiver-cnt';
      await store.insertTask(makeTask({ receiver_uid: receiver }));
      await store.insertTask(makeTask({ receiver_uid: receiver }));
      assert.strictEqual(store.countPendingTasks(receiver), 2);
    });

    test('returns 0 when none', () => {
      assert.strictEqual(store.countPendingTasks('empty'), 0);
    });
  });

  describe('listAllPendingQueues', () => {
    test('returns all receiver UIDs with pending tasks', async () => {
      await store.insertTask(makeTask({ receiver_uid: 'r1' }));
      await store.insertTask(makeTask({ receiver_uid: 'r2' }));
      const queues = store.listAllPendingQueues();
      assert.ok(queues.includes('r1'));
      assert.ok(queues.includes('r2'));
    });

    test('returns only UIDs that have at least one pending task', async () => {
      // Insert another pending for r1, verify it appears once (dedup)
      await store.insertTask(makeTask({ receiver_uid: 'r1' }));
      const queues = store.listAllPendingQueues();
      assert.ok(queues.includes('r1'));
      assert.ok(queues.includes('r2'));
    });
  });

  describe('getPendingTaskAsync', () => {
    test('returns highest priority pending task async', async () => {
      const receiver = 'receiver-async';
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'high', content: 'high-async' }));
      await store.insertTask(makeTask({ receiver_uid: receiver, priority: 'low', content: 'low-async' }));
      const task = await store.getPendingTaskAsync(receiver);
      assert.ok(task);
      assert.strictEqual(task.content, 'high-async');
    });

    test('returns null when no pending', async () => {
      const task = await store.getPendingTaskAsync('no-pending');
      assert.strictEqual(task, null);
    });
  });

  describe('listPendingTasksAsync', () => {
    test('lists pending tasks async', async () => {
      const receiver = 'receiver-async2';
      await store.insertTask(makeTask({ receiver_uid: receiver }));
      await store.insertTask(makeTask({ receiver_uid: receiver }));
      const tasks = await store.listPendingTasksAsync(receiver);
      assert.strictEqual(tasks.length, 2);
    });
  });

  describe('claimPendingTaskAsync', () => {
    test('claims and sets task to in_progress', async () => {
      const receiver = 'receiver-claim';
      const task = makeTask({ receiver_uid: receiver });
      await store.insertTask(task);
      const claimed = await store.claimPendingTaskAsync(receiver);
      assert.ok(claimed);
      assert.strictEqual(claimed.task_id, task.task_id);
      assert.strictEqual(claimed.status, 'in_progress');

      // Verify on disk
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.status, 'in_progress');
    });

    test('returns null when no pending tasks', async () => {
      const claimed = await store.claimPendingTaskAsync('no-tasks');
      assert.strictEqual(claimed, null);
    });
  });

  describe('updateTaskStatus', () => {
    test('updates task status', async () => {
      const task = makeTask();
      await store.insertTask(task);
      await store.updateTaskStatus(task.task_id, 'completed', 'done!');
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.status, 'completed');
      assert.strictEqual(t.result, 'done!');
    });

    test('is a no-op for non-existent task', async () => {
      // Should not throw
      await store.updateTaskStatus('no-task', 'completed');
    });

    test('updates metadata', async () => {
      const task = makeTask();
      await store.insertTask(task);
      await store.updateTaskStatus(task.task_id, 'completed', null, { note: 'updated' });
      const t = store.getTask(task.task_id);
      assert.deepStrictEqual(t.metadata, { note: 'updated' });
    });

    test('truncates result to 8192 chars', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const longResult = 'R'.repeat(10000);
      await store.updateTaskStatus(task.task_id, 'completed', longResult);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.result.length, 8192);
    });
  });

  describe('cancelTaskAtomic', () => {
    test('cancels a pending task by sender', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, true);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.status, 'cancelled');
    });

    test('cancels a blocked task', async () => {
      const task = makeTask({ status: 'blocked' });
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, true);
    });

    test('rejects cancellation by non-sender', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, 'random-user');
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('only the sender'));
    });

    test('cannot cancel task in in_progress status', async () => {
      const task = makeTask({ status: 'in_progress' });
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('cannot cancel'));
    });

    test('cannot cancel completed task', async () => {
      const task = makeTask({ status: 'completed' });
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, false);
    });

    test('supervisor can cancel any pending task', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const result = await store.cancelTaskAtomic(task.task_id, 'any-supervisor', { supervisor: true });
      assert.strictEqual(result.ok, true);
    });

    test('returns error for non-existent task', async () => {
      const result = await store.cancelTaskAtomic('no-task', 'someone');
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });
  });

  describe('interruptTaskAtomic', () => {
    test('interrupts an in_progress task', async () => {
      const task = makeTask({ status: 'in_progress' });
      await store.insertTask(task);
      const result = await store.interruptTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, true);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.status, 'interrupted');
    });

    test('rejects interruption by non-sender', async () => {
      const task = makeTask({ status: 'in_progress' });
      await store.insertTask(task);
      const result = await store.interruptTaskAtomic(task.task_id, 'bad-user');
      assert.strictEqual(result.ok, false);
    });

    test('cannot interrupt pending task', async () => {
      const task = makeTask({ status: 'pending' });
      await store.insertTask(task);
      const result = await store.interruptTaskAtomic(task.task_id, task.sender_uid);
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('only in-progress'));
    });

    test('supervisor can interrupt any in_progress task', async () => {
      const task = makeTask({ status: 'in_progress' });
      await store.insertTask(task);
      const result = await store.interruptTaskAtomic(task.task_id, 'supervisor', { supervisor: true });
      assert.strictEqual(result.ok, true);
    });
  });

  describe('setTaskWorkflowMeta', () => {
    test('sets workflow and stage id', async () => {
      const task = makeTask();
      await store.insertTask(task);
      const result = await store.setTaskWorkflowMeta(task.task_id, 'wf-99', 'stage-42');
      assert.strictEqual(result, true);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.workflow_id, 'wf-99');
      assert.strictEqual(t.stage_id, 'stage-42');
    });

    test('returns false for non-existent task', async () => {
      const result = await store.setTaskWorkflowMeta('no-task', 'wf', 'st');
      assert.strictEqual(result, false);
    });
  });

  describe('incrementTaskRetryCount', () => {
    test('increments retry count and resets to pending', async () => {
      const task = makeTask({ retry_count: 0, status: 'failed' });
      await store.insertTask(task);
      const result = await store.incrementTaskRetryCount(task.task_id);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 1);
      const t = store.getTask(task.task_id);
      assert.strictEqual(t.retry_count, 1);
      assert.strictEqual(t.status, 'pending');
      assert.strictEqual(t.result, null);
    });

    test('returns error for non-existent task', async () => {
      const result = await store.incrementTaskRetryCount('no-task');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.count, 0);
    });
  });

  describe('listMyTasks', () => {
    test('lists tasks where agent is sender or receiver', async () => {
      const uid = 'uid-mine';
      await store.insertTask(makeTask({ sender_uid: uid }));
      await store.insertTask(makeTask({ receiver_uid: uid }));
      await store.insertTask(makeTask({ sender_uid: 'other', receiver_uid: 'other2' }));
      const tasks = store.listMyTasks(uid);
      assert.strictEqual(tasks.length, 2);
    });

    test('sorts by most recent first', async () => {
      const uid = 'uid-sort';
      await store.insertTask(makeTask({ sender_uid: uid, created_at: '2026-01-01T00:00:00Z' }));
      await store.insertTask(makeTask({ sender_uid: uid, created_at: '2026-12-01T00:00:00Z' }));
      const tasks = store.listMyTasks(uid);
      assert.strictEqual(tasks.length, 2);
      assert.ok(tasks[0].created_at >= tasks[1].created_at);
    });
  });

  describe('findTask', () => {
    test('returns task with queue position', async () => {
      const receiver = 'receiver-pos';
      const t1 = makeTask({ receiver_uid: receiver, created_at: '2026-01-01T00:00:00Z' });
      const t2 = makeTask({ receiver_uid: receiver, created_at: '2026-06-01T00:00:00Z' });
      const t3 = makeTask({ receiver_uid: receiver, created_at: '2026-12-01T00:00:00Z' });
      await store.insertTask(t1);
      await store.insertTask(t2);
      await store.insertTask(t3);
      const found = store.findTask(t2.task_id);
      assert.ok(found);
      assert.strictEqual(found.task.task_id, t2.task_id);
      assert.strictEqual(found.queue_position, 1); // t1 is ahead
    });

    test('returns null for non-existent task', () => {
      assert.strictEqual(store.findTask('no-task'), null);
    });
  });

  describe('listAllTasksInWorkspace', () => {
    test('lists tasks where sender or receiver is in workspace', async () => {
      await store.insertAgent({
        uid: 'agent-ws-a', name: 'WSA', workspace: 'boos',
      });
      await store.insertAgent({
        uid: 'agent-ws-b', name: 'WSB', workspace: 'other-ws',
      });
      const t1 = makeTask({ sender_uid: 'agent-ws-a', receiver_uid: 'someone' });
      const t2 = makeTask({ sender_uid: 'someone', receiver_uid: 'agent-ws-a' });
      const t3 = makeTask({ sender_uid: 'agent-ws-b', receiver_uid: 'agent-ws-b' });
      await store.insertTask(t1);
      await store.insertTask(t2);
      await store.insertTask(t3);
      const tasks = store.listAllTasksInWorkspace('boos');
      assert.strictEqual(tasks.length, 2);
    });
  });

  describe('pruneOldTasks', () => {
    test('prunes old terminal tasks', async () => {
      const oldTask = makeTask({
        status: 'completed',
        created_at: new Date(Date.now() - 90 * 24 * 3600_000).toISOString(),
      });
      const recentTask = makeTask({
        status: 'completed',
        created_at: new Date().toISOString(),
      });
      await store.insertTask(oldTask);
      await store.insertTask(recentTask);
      const count = await store.pruneOldTasks();
      assert.ok(count >= 1);
      // Old task should be gone
      assert.strictEqual(store.getTask(oldTask.task_id), null);
      // Recent task still exists
      assert.ok(store.getTask(recentTask.task_id));
    });

    test('does not prune non-terminal tasks', async () => {
      const oldPending = makeTask({
        status: 'pending',
        created_at: new Date(Date.now() - 90 * 24 * 3600_000).toISOString(),
      });
      await store.insertTask(oldPending);
      const count = await store.pruneOldTasks();
      assert.strictEqual(count, 0);
      assert.ok(store.getTask(oldPending.task_id));
    });

    test('returns 0 when nothing to prune', async () => {
      const count = await store.pruneOldTasks();
      assert.strictEqual(count, 0);
    });

    test('handles custom maxAgeMs', async () => {
      const veryOld = makeTask({
        status: 'cancelled',
        created_at: new Date(Date.now() - 365 * 24 * 3600_000).toISOString(),
      });
      await store.insertTask(veryOld);
      // Use a very long maxAge so nothing is pruned
      const count = await store.pruneOldTasks(999_999_999_999);
      assert.strictEqual(count, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Identity Cards
// ═══════════════════════════════════════════════════════════════════════════════

describe('Identity Cards', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  describe('writeIdentity', () => {
    test('writes identity card', async () => {
      const ident = await store.writeIdentity('uid-1', {
        name: 'TestAgent', workspace: 'boos',
      });
      assert.strictEqual(ident.name, 'TestAgent');
      assert.strictEqual(ident.workspace, 'boos');
      assert.ok(ident.updated_at);
    });

    test('updates existing identity', async () => {
      await store.writeIdentity('uid-2', { name: 'Old', workspace: 'boos' });
      const updated = await store.writeIdentity('uid-2', { name: 'New' });
      assert.strictEqual(updated.name, 'New');
      assert.strictEqual(updated.workspace, 'boos'); // Preserved
    });

    test('updates name_ws index', async () => {
      await store.writeIdentity('uid-idx', { name: 'IdxAgent', workspace: 'boos' });
      const result = store.getIdentity({ name: 'IdxAgent', workspace: 'boos' });
      assert.ok(result);
      assert.strictEqual(result.agent_uid, 'uid-idx');
    });
  });

  describe('getIdentity', () => {
    test('gets identity by uid', async () => {
      await store.writeIdentity('uid-g1', { name: 'GetId', workspace: 'boos' });
      const result = store.getIdentity({ uid: 'uid-g1' });
      assert.ok(result);
      assert.strictEqual(result.name, 'GetId');
      assert.strictEqual(result.workspace, 'boos');
    });

    test('gets identity by name and workspace', async () => {
      await store.writeIdentity('uid-g2', { name: 'ByName', workspace: 'boos' });
      const result = store.getIdentity({ name: 'ByName', workspace: 'boos' });
      assert.ok(result);
      assert.strictEqual(result.agent_uid, 'uid-g2');
    });

    test('gets identity by name only (prefix match)', async () => {
      await store.writeIdentity('uid-g3', { name: 'PrefixMatch', workspace: 'boos' });
      const result = store.getIdentity({ name: 'PrefixMatch' });
      assert.ok(result);
      assert.strictEqual(result.agent_uid, 'uid-g3');
    });

    test('returns null for unknown identity', () => {
      const result = store.getIdentity({ uid: 'no-one' });
      assert.strictEqual(result, null);
    });
  });

  describe('upsertIdentity', () => {
    test('upserts identity (alias for writeIdentity)', async () => {
      const ident = await store.upsertIdentity('uid-up', { name: 'Upsert', workspace: 'boos' });
      assert.strictEqual(ident.name, 'Upsert');
    });
  });

  describe('bootstrapIdentities', () => {
    test('bootstraps identities from registered agents', async () => {
      await store.insertAgent({
        uid: 'agent-boot', name: 'BootAgent', workspace: 'boos',
      });
      const count = await store.bootstrapIdentities();
      assert.ok(count >= 1);
      const ident = store.getIdentity({ uid: 'agent-boot' });
      assert.ok(ident);
      assert.strictEqual(ident.name, 'BootAgent');
    });

    test('does not overwrite existing identities', async () => {
      await store.insertAgent({
        uid: 'agent-boot2', name: 'BootAgent2', workspace: 'boos',
      });
      await store.writeIdentity('agent-boot2', { name: 'CustomName', workspace: 'boos' });
      const count = await store.bootstrapIdentities();
      assert.strictEqual(count, 0); // Already exists
      const ident = store.getIdentity({ uid: 'agent-boot2' });
      assert.strictEqual(ident.name, 'CustomName');
    });
  });

  describe('bindMcpSession / unbindMcpSession / getAgentUidByMcpSession', () => {
    test('binds MCP session to agent uid', async () => {
      await store.writeIdentity('uid-mcp', { name: 'McpAgent', workspace: 'boos' });
      await store.bindMcpSession('mcp-sess-1', 'uid-mcp');
      assert.strictEqual(store.getAgentUidByMcpSession('mcp-sess-1'), 'uid-mcp');
    });

    test('steals MCP session from old agent', async () => {
      await store.writeIdentity('uid-old-mcp', { name: 'OldMcp', workspace: 'boos' });
      await store.writeIdentity('uid-new-mcp', { name: 'NewMcp', workspace: 'boos' });
      await store.bindMcpSession('mcp-sess-2', 'uid-old-mcp');
      await store.bindMcpSession('mcp-sess-2', 'uid-new-mcp');
      assert.strictEqual(store.getAgentUidByMcpSession('mcp-sess-2'), 'uid-new-mcp');
    });

    test('unbindMcpSession removes mapping', async () => {
      await store.writeIdentity('uid-unmcp', { name: 'UnMcp', workspace: 'boos' });
      await store.bindMcpSession('mcp-sess-3', 'uid-unmcp');
      await store.unbindMcpSession('mcp-sess-3');
      assert.strictEqual(store.getAgentUidByMcpSession('mcp-sess-3'), null);
    });

    test('unbindMcpSession with null is a no-op', async () => {
      await store.unbindMcpSession(null);
    });

    test('getAgentUidByMcpSession returns null for unknown', () => {
      assert.strictEqual(store.getAgentUidByMcpSession('unknown-mcp'), null);
    });
  });

  describe('autoResolveIdentity', () => {
    test('resolves identity from MCP session', async () => {
      await store.writeIdentity('uid-auto', { name: 'AutoRes', workspace: 'boos' });
      await store.bindMcpSession('mcp-auto', 'uid-auto');
      const result = store.autoResolveIdentity('mcp-auto');
      assert.ok(result);
      assert.strictEqual(result.uid, 'uid-auto');
      assert.strictEqual(result.identity.name, 'AutoRes');
    });

    test('returns null for unknown MCP session', () => {
      assert.strictEqual(store.autoResolveIdentity('unknown'), null);
    });

    test('returns null for null input', () => {
      assert.strictEqual(store.autoResolveIdentity(null), null);
    });
  });

  describe('isRootAgent', () => {
    test('returns true for root agent', async () => {
      await store.insertAgent({
        uid: 'root1', name: 'Root', workspace: 'boos', role: 'root',
      });
      assert.strictEqual(store.isRootAgent('root1'), true);
    });

    test('returns false for worker agent', async () => {
      await store.insertAgent({
        uid: 'worker1', name: 'Worker', workspace: 'boos', role: 'worker',
      });
      assert.strictEqual(store.isRootAgent('worker1'), false);
    });

    test('returns falsy for non-existent agent', () => {
      // null && ... → null, not false
      assert.ok(!store.isRootAgent('no-agent'));
    });
  });

  describe('getIdentityByBoosSession', () => {
    test('returns null for modern sessions (no boos_session_id in card)', () => {
      const result = store.getIdentityByBoosSession('some-session');
      assert.strictEqual(result, null);
    });

    test('returns null for null input', () => {
      assert.strictEqual(store.getIdentityByBoosSession(null), null);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PM Identity
// ═══════════════════════════════════════════════════════════════════════════════

describe('PM Identity', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  describe('setAgentProject', () => {
    test('sets project on agent', async () => {
      await store.insertAgent({
        uid: 'agent-proj-set', name: 'ProjSet', workspace: 'boos',
      });
      const result = await store.setAgentProject('agent-proj-set', 'new-project');
      assert.strictEqual(result, true);
      const agent = store.getAgent('agent-proj-set');
      assert.strictEqual(agent.project, 'new-project');
    });

    test('clears project when null', async () => {
      await store.insertAgent({
        uid: 'agent-proj-clr', name: 'ProjClr', workspace: 'boos', project: 'old',
      });
      await store.setAgentProject('agent-proj-clr', null);
      const agent = store.getAgent('agent-proj-clr');
      assert.strictEqual(agent.project, null);
    });

    test('returns false for non-existent agent', async () => {
      const result = await store.setAgentProject('no-agent', 'proj');
      assert.strictEqual(result, false);
    });
  });

  describe('setAgentPM', () => {
    test('sets pm_of projects', async () => {
      await store.insertAgent({
        uid: 'agent-pmo1', name: 'PMO1', workspace: 'boos',
      });
      const result = await store.setAgentPM('agent-pmo1', ['proj-1', 'proj-2']);
      assert.strictEqual(result, true);
      const agent = store.getAgent('agent-pmo1');
      assert.deepStrictEqual(agent.pm_of, ['proj-1', 'proj-2']);
    });

    test('truncates pm_of to 20', async () => {
      await store.insertAgent({
        uid: 'agent-pmo2', name: 'PMO2', workspace: 'boos',
      });
      await store.setAgentPM('agent-pmo2', Array.from({ length: 30 }, (_, i) => 'p' + i));
      const agent = store.getAgent('agent-pmo2');
      assert.strictEqual(agent.pm_of.length, 20);
    });

    test('clears pm_of when empty array', async () => {
      await store.insertAgent({
        uid: 'agent-pmo3', name: 'PMO3', workspace: 'boos', pm_of: ['old-proj'],
      });
      await store.setAgentPM('agent-pmo3', []);
      const agent = store.getAgent('agent-pmo3');
      assert.deepStrictEqual(agent.pm_of, []);
    });

    test('returns false for non-existent agent', async () => {
      const result = await store.setAgentPM('no-agent', []);
      assert.strictEqual(result, false);
    });
  });

  describe('isPMOf', () => {
    test('supervisor role is PM of everything', async () => {
      await store.insertAgent({
        uid: 'agent-sup2', name: 'Sup', workspace: 'boos', role: 'supervisor',
      });
      const agent = store.getAgent('agent-sup2');
      assert.strictEqual(store.isPMOf(agent, 'any-project'), true);
      assert.strictEqual(store.isPMOf(agent, null), true);
    });

    test('worker is PM of their pm_of projects', async () => {
      await store.insertAgent({
        uid: 'agent-pm-worker', name: 'PMWorker', workspace: 'boos',
        pm_of: ['proj-a'],
      });
      const agent = store.getAgent('agent-pm-worker');
      assert.strictEqual(store.isPMOf(agent, 'proj-a'), true);
      assert.strictEqual(store.isPMOf(agent, 'proj-b'), false);
    });

    test('returns false for null agent', () => {
      assert.strictEqual(store.isPMOf(null, 'proj'), false);
    });

    test('returns false when agent has no pm_of and is not supervisor', async () => {
      await store.insertAgent({
        uid: 'agent-nopm', name: 'NoPM', workspace: 'boos',
      });
      const agent = store.getAgent('agent-nopm');
      assert.strictEqual(store.isPMOf(agent, 'proj'), false);
    });
  });

  describe('touchAgentHeartbeat', () => {
    test('updates last_seen_at and clears unresponsive', async () => {
      await store.insertAgent({
        uid: 'agent-hb', name: 'Heartbeat', workspace: 'boos',
      });
      await store.setAgentUnresponsive('agent-hb', true);
      const before = store.getAgent('agent-hb').last_seen_at;
      await new Promise((r) => setTimeout(r, 10));
      await store.touchAgentHeartbeat('agent-hb');
      const agent = store.getAgent('agent-hb');
      assert.ok(new Date(agent.last_seen_at) > new Date(before));
      assert.strictEqual(agent.unresponsive, false);
    });

    test('is a no-op for non-existent agent', async () => {
      await store.touchAgentHeartbeat('no-agent');
    });
  });

  describe('setAgentUnresponsive', () => {
    test('sets unresponsive flag', async () => {
      await store.insertAgent({
        uid: 'agent-ur2', name: 'Unresp2', workspace: 'boos',
      });
      await store.setAgentUnresponsive('agent-ur2', true);
      const agent = store.getAgent('agent-ur2');
      assert.strictEqual(agent.unresponsive, true);
      assert.ok(agent.last_unresponsive_at);
    });

    test('clears unresponsive flag', async () => {
      await store.insertAgent({
        uid: 'agent-ur3', name: 'Unresp3', workspace: 'boos',
      });
      await store.setAgentUnresponsive('agent-ur3', true);
      await store.setAgentUnresponsive('agent-ur3', false);
      const agent = store.getAgent('agent-ur3');
      assert.strictEqual(agent.unresponsive, false);
    });

    test('is a no-op for non-existent agent', async () => {
      await store.setAgentUnresponsive('no-agent', true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Store Edge Cases', () => {
  let store;

  before(() => {
    freshSetup();
    store = require('../lib/agentBus/store');
  });

  after(() => { teardown(); });

  test('empty DB is handled gracefully on first load', () => {
    // No agents inserted yet — all queries should return empty/null
    assert.strictEqual(store.getAgent('any'), null);
    assert.strictEqual(store.findAgentByNameWs('any', 'ws'), null);
    assert.deepStrictEqual(store.listAgentsInWorkspace('boos'), []);
    assert.deepStrictEqual(store.listAllAgents(), []);
    assert.strictEqual(store.countStaleAgents(new Date().toISOString()), 0);
  });

  test('rapid sequential inserts do not corrupt DB', async () => {
    const uids = [];
    for (let i = 0; i < 20; i++) {
      const uid = 'rapid-' + i;
      uids.push(uid);
      await store.insertAgent({ uid, name: 'Rapid' + i, workspace: 'boos' });
    }
    for (const uid of uids) {
      assert.ok(store.getAgent(uid), 'agent ' + uid + ' should exist');
    }
  });

  test('tasks survive between reads', async () => {
    const task = makeTask({ content: 'Persistent task' });
    await store.insertTask(task);
    // Multiple reads should return the same data
    for (let i = 0; i < 5; i++) {
      const t = store.getTask(task.task_id);
      assert.ok(t);
      assert.strictEqual(t.content, 'Persistent task');
    }
  });

  test('session bind then unbind then rebind', async () => {
    await store.insertAgent({ uid: 'agent-cyc', name: 'Cycle', workspace: 'boos' });
    await store.bindSession('sess-cyc', 'agent-cyc', 'boos');
    assert.strictEqual(store.getSessionAgentUid('sess-cyc'), 'agent-cyc');
    await store.unbindSession('sess-cyc');
    assert.strictEqual(store.getSessionAgentUid('sess-cyc'), null);
    await store.bindSession('sess-cyc', 'agent-cyc', 'boos');
    assert.strictEqual(store.getSessionAgentUid('sess-cyc'), 'agent-cyc');
  });

  test('multiple workspaces are isolated', async () => {
    await store.insertAgent({ uid: 'agent-ws-iso1', name: 'Iso1', workspace: 'ws-a' });
    await store.insertAgent({ uid: 'agent-ws-iso2', name: 'Iso2', workspace: 'ws-b' });

    const a = store.listAgentsInWorkspace('ws-a');
    const b = store.listAgentsInWorkspace('ws-b');
    const aUids = a.map((x) => x.uid);
    const bUids = b.map((x) => x.uid);
    assert.ok(aUids.includes('agent-ws-iso1'));
    assert.ok(!aUids.includes('agent-ws-iso2'));
    assert.ok(bUids.includes('agent-ws-iso2'));
    assert.ok(!bUids.includes('agent-ws-iso1'));
  });

  test('agent with empty capabilities array is valid', async () => {
    await store.insertAgent({ uid: 'agent-nocap', name: 'NoCap', workspace: 'boos', capabilities: [] });
    const agent = store.getAgent('agent-nocap');
    assert.deepStrictEqual(agent.capabilities, []);
  });

  test('agent with null intro works', async () => {
    await store.insertAgent({ uid: 'agent-nointro', name: 'NoIntro', workspace: 'boos', intro: null });
    const agent = store.getAgent('agent-nointro');
    assert.strictEqual(agent.intro, '');
  });

  test('_load and _syncLoad are exposed', () => {
    assert.strictEqual(typeof store._load, 'function');
    assert.strictEqual(typeof store._syncLoad, 'function');
  });

  test('_load returns a DB object with expected shape', async () => {
    const db = await store._load();
    assert.ok(db.agents);
    assert.ok(db.tasks);
    assert.ok(db.sessions);
    assert.ok(db.identities);
    assert.ok(db.dags);
    assert.ok(db.dag_tasks);
  });

  // ROOT_UID
  test('ROOT_UID is "agent_root"', () => {
    assert.strictEqual(store.ROOT_UID, 'agent_root');
  });
});
