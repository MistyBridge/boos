// goalStore integration tests — Sprint 37.
//
// Tests the Goal persistence layer:
//   - CRUD operations (create, get, list, update)
//   - Status transitions (start, pause, archive)
//   - DAG association (addDagToGoal)
//   - PM/PMO resolution (soft-coded, never hardcoded)
//   - Feedback thread persistence
//
// Uses the real agent-bus DB with test workspace to validate integration.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('node:path');

let goalStore, store, registry;
let _testHome;
before(() => {
  // Isolate from real ~/.boos production data + other test files in the
  // same run. Module-level DATA_DIR binds at load, so re-require after set.
  _testHome = path.join(os.tmpdir(), 'boos-goals-' + Date.now().toString(36));
  fs.mkdirSync(_testHome, { recursive: true });
  process.env.BOOS_HOME = _testHome;
  for (const m of ['../lib/config', '../lib/agentBus/storeCore',
    '../lib/agentBus/store', '../lib/agentBus/storeAgents',
    '../lib/agentBus/storeTasks', '../lib/agentBus/storeIdentity',
    '../lib/agentBus/goalStore', '../lib/agentBus/registry',
    '../lib/agentBus/auth', '../lib/agentBus/handlersAdmin']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  goalStore = require('../lib/agentBus/goalStore');
  store = require('../lib/agentBus/store');
  registry = require('../lib/agentBus/registry');
});
after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(_testHome, { recursive: true, force: true }); } catch {}
});

const TEST_WS = 'test-goals';
const TEST_PROJECT = 'test-project';

// ── test setup ───────────────────────────────────────────────────────────────

// Write test agents directly to the store DB (same pattern as dagDecomposer.test.js).
// The registry.registerAgent requires cliSessionId which test agents don't have.

async function registerTestAgents() {
  const { withFileLock } = require('../lib/agentBus/storeCore');
  const { atomicWriteJson } = require('../lib/atomicJson');

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    if (!db.agents) db.agents = {};
    if (!db.name_ws_index) db.name_ws_index = {};

    const agents = [
      { uid: 'test-gs-pm-uid',  name: 'TestPM',  intro: 'Test PM',  workspace: TEST_WS, role: 'supervisor', capabilities: ['architecture'], project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
      { uid: 'test-gs-pmo-uid', name: 'TestPMO', intro: 'Test PMO', workspace: TEST_WS, role: 'pmo',        capabilities: ['planning'],     project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
    ];

    for (const a of agents) {
      db.agents[a.uid] = a;
      db.name_ws_index[`${a.name}|${TEST_WS}`] = a.uid;
    }
    await atomicWriteJson(store.DB_PATH, db);
  });
}

async function cleanupTestAgents() {
  const { withFileLock } = require('../lib/agentBus/storeCore');
  const { atomicWriteJson } = require('../lib/atomicJson');
  const testUids = ['test-gs-pm-uid', 'test-gs-pmo-uid'];

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    for (const uid of testUids) {
      if (db.agents[uid]) {
        const key = `${db.agents[uid].name}|${TEST_WS}`;
        delete db.name_ws_index[key];
        delete db.agents[uid];
      }
    }
    await atomicWriteJson(store.DB_PATH, db);
  });
}

async function cleanupTestData() {
  // Remove test goals from goals.json.
  try {
    const db = await goalStore._load ? goalStore._load() : {};
    // Actually use the file path directly.
    const goalsPath = goalStore.GOALS_PATH;
    if (fs.existsSync(goalsPath)) {
      const raw = fs.readFileSync(goalsPath, 'utf-8');
      const data = JSON.parse(raw);
      let changed = false;
      for (const [id, g] of Object.entries(data)) {
        if (g.workspace === TEST_WS) { delete data[id]; changed = true; }
      }
      if (changed) fs.writeFileSync(goalsPath, JSON.stringify(data, null, 2));
    }
  } catch {}

  // Deregister test agents.
  try {
    const agents = registry.listAgentsInWorkspace(TEST_WS);
    for (const a of agents) {
      registry.deregisterAgent(a.uid);
    }
  } catch {}
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('goalStore', () => {
  before(async () => {
    await cleanupTestData();
    await registerTestAgents();
  });

  after(async () => {
    await cleanupTestData();
    await cleanupTestAgents();
  });

  describe('createGoal()', () => {
    it('should create a goal and auto-resolve PM', async () => {
      const result = await goalStore.createGoal({
        title: 'Test Goal 1',
        description: 'A test goal for goalStore tests.',
        workspace: TEST_WS,
        project: TEST_PROJECT,
        creatorUid: 'test-user-1',
      });

      assert.ok(result.ok);
      assert.ok(result.goal.goal_id.startsWith('goal_'));
      assert.equal(result.goal.title, 'Test Goal 1');
      assert.equal(result.goal.status, 'submitted');
      assert.equal(result.goal.workspace, TEST_WS);
      assert.equal(result.goal.project, TEST_PROJECT);
      assert.ok(result.goal.assigned_pm_uid, 'PM should be auto-resolved');
      assert.ok(result.goal.dag_ids.length === 0);
    });

    it('should reject goal without title', async () => {
      const result = await goalStore.createGoal({
        title: '',
        description: 'Missing title.',
        workspace: TEST_WS,
        creatorUid: 'test-user-1',
      });
      assert.ok(!result.ok);
      assert.ok(result.error.includes('title'));
    });

    it('should reject goal without workspace', async () => {
      const result = await goalStore.createGoal({
        title: 'No workspace',
        description: '',
        workspace: '',
        creatorUid: 'test-user-1',
      });
      assert.ok(!result.ok);
    });
  });

  describe('getGoal() + listGoals()', () => {
    let goalId;

    before(async () => {
      const r = await goalStore.createGoal({
        title: 'Test Goal for queries',
        description: 'Testing get/list.',
        workspace: TEST_WS,
        project: TEST_PROJECT,
        creatorUid: 'test-user-1',
      });
      goalId = r.goal.goal_id;
    });

    it('should get a goal by ID', () => {
      const goal = goalStore.getGoal(goalId);
      assert.ok(goal);
      assert.equal(goal.goal_id, goalId);
      assert.equal(goal.title, 'Test Goal for queries');
    });

    it('should return null for unknown goal', () => {
      const goal = goalStore.getGoal('goal_nonexistent');
      assert.equal(goal, null);
    });

    it('should list goals by workspace', async () => {
      const goals = await goalStore.listGoals(TEST_WS);
      assert.ok(goals.length >= 1);
      assert.ok(goals.every((g) => g.workspace === TEST_WS));
    });

    it('should filter by project', async () => {
      const goals = await goalStore.listGoals(TEST_WS, TEST_PROJECT);
      assert.ok(goals.length >= 1);
      assert.ok(goals.every((g) => g.project === TEST_PROJECT));
    });

    it('should filter by status', async () => {
      const goals = await goalStore.listGoals(TEST_WS, null, 'submitted');
      assert.ok(goals.length >= 1);
      assert.ok(goals.every((g) => g.status === 'submitted'));
    });

    it('should return empty for unknown workspace', async () => {
      const goals = await goalStore.listGoals('nonexistent-ws');
      assert.deepEqual(goals, []);
    });
  });

  describe('updateGoal()', () => {
    let goalId;

    before(async () => {
      const r = await goalStore.createGoal({
        title: 'Test Goal for update',
        description: 'Original description.',
        workspace: TEST_WS,
        creatorUid: 'test-user-1',
      });
      goalId = r.goal.goal_id;
    });

    it('should update allowed fields', async () => {
      const r = await goalStore.updateGoal(goalId, {
        title: 'Updated Title',
        description: 'Updated description.',
        status: 'decomposing',
      });
      assert.ok(r.ok);
      assert.equal(r.goal.title, 'Updated Title');
      assert.equal(r.goal.description, 'Updated description.');
      assert.equal(r.goal.status, 'decomposing');
    });

    it('should reject update for unknown goal', async () => {
      try {
        await goalStore.updateGoal('goal_nonexistent', { title: 'x' });
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('not found'));
      }
    });

    it('should update updated_at on change', async () => {
      const before = goalStore.getGoal(goalId);
      await new Promise((r) => setTimeout(r, 10));
      const result = await goalStore.updateGoal(goalId, { title: 'Title v3' });
      assert.ok(result.goal.updated_at > before.updated_at);
    });
  });

  describe('addDagToGoal()', () => {
    let goalId;

    before(async () => {
      const r = await goalStore.createGoal({
        title: 'Test Goal for DAG linking',
        description: 'Testing DAG association.',
        workspace: TEST_WS,
        creatorUid: 'test-user-1',
      });
      goalId = r.goal.goal_id;
    });

    it('should add DAG IDs to goal', async () => {
      const r1 = await goalStore.addDagToGoal(goalId, 'dag_test_001');
      assert.ok(r1.ok);
      assert.ok(r1.goal.dag_ids.includes('dag_test_001'));

      const r2 = await goalStore.addDagToGoal(goalId, 'dag_test_002');
      assert.ok(r2.ok);
      assert.equal(r2.goal.dag_ids.length, 2);
    });

    it('should not duplicate DAG IDs', async () => {
      const r = await goalStore.addDagToGoal(goalId, 'dag_test_001');
      const count = r.goal.dag_ids.filter((id) => id === 'dag_test_001').length;
      assert.equal(count, 1);
    });

    it('should auto-transition submitted → decomposing on first DAG', async () => {
      const r = await goalStore.createGoal({
        title: 'Auto transition test',
        description: '',
        workspace: TEST_WS,
        creatorUid: 'test-user-1',
      });
      assert.equal(r.goal.status, 'submitted');
      const r2 = await goalStore.addDagToGoal(r.goal.goal_id, 'dag_auto_001');
      assert.equal(r2.goal.status, 'decomposing');
    });
  });

  describe('addFeedback()', () => {
    let goalId;

    before(async () => {
      const r = await goalStore.createGoal({
        title: 'Test Goal for feedback',
        description: 'Testing feedback thread.',
        workspace: TEST_WS,
        creatorUid: 'test-user-1',
      });
      goalId = r.goal.goal_id;
    });

    it('should add feedback entry to goal', async () => {
      const r = await goalStore.addFeedback(goalId, {
        fromUid: 'test-user-1',
        fromName: 'Test User',
        content: 'This is a test feedback message.',
        type: 'overall',
      });
      assert.ok(r.ok);

      const goal = goalStore.getGoal(goalId);
      assert.equal(goal.feedback_thread.length, 1);
      assert.equal(goal.feedback_thread[0].content, 'This is a test feedback message.');
      assert.equal(goal.feedback_thread[0].type, 'overall');
    });

    it('should add node-level feedback with target_task_id', async () => {
      const r = await goalStore.addFeedback(goalId, {
        fromUid: 'test-user-1',
        fromName: 'Test User',
        content: 'Question about node X.',
        type: 'node',
        targetTaskId: 'task_abc123',
      });
      assert.ok(r.ok);

      const goal = goalStore.getGoal(goalId);
      const entry = goal.feedback_thread.find((e) => e.target_task_id === 'task_abc123');
      assert.ok(entry);
      assert.equal(entry.type, 'node');
    });
  });

  describe('resolveProjectPM / resolveProjectPMO', () => {
    it('should resolve PM (supervisor) in workspace', () => {
      const pmUid = goalStore.resolveProjectPM(TEST_WS);
      assert.ok(pmUid, 'PM should be resolvable');
      const agent = store.getAgent(pmUid);
      assert.equal(agent.role, 'supervisor');
    });

    it('should resolve PMO in workspace', () => {
      const pmoUid = goalStore.resolveProjectPMO(TEST_WS);
      assert.ok(pmoUid, 'PMO should be resolvable');
      const agent = store.getAgent(pmoUid);
      assert.equal(agent.role, 'pmo');
    });

    it('should return null for unknown workspace', () => {
      const pm = goalStore.resolveProjectPM('nonexistent');
      assert.equal(pm, null);
    });
  });

  describe('status transitions', () => {
    it('startGoal: should transition approved → active', async () => {
      const r = await goalStore.createGoal({
        title: 'Transitions - start', description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      await goalStore.updateGoal(r.goal.goal_id, { status: 'approved' });
      const result = await goalStore.startGoal(r.goal.goal_id);
      assert.ok(result.ok);
      assert.equal(result.goal.status, 'active');
    });

    it('pauseGoal: should transition active → paused', async () => {
      const r = await goalStore.createGoal({
        title: 'Transitions - pause', description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      await goalStore.updateGoal(r.goal.goal_id, { status: 'approved' });
      await goalStore.startGoal(r.goal.goal_id);
      const result = await goalStore.pauseGoal(r.goal.goal_id);
      assert.ok(result.ok);
      assert.equal(result.goal.status, 'paused');
    });

    it('startGoal: should transition paused → active (resume)', async () => {
      const r = await goalStore.createGoal({
        title: 'Transitions - resume', description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      await goalStore.updateGoal(r.goal.goal_id, { status: 'approved' });
      await goalStore.startGoal(r.goal.goal_id);
      await goalStore.pauseGoal(r.goal.goal_id);
      const result = await goalStore.startGoal(r.goal.goal_id);
      assert.ok(result.ok);
      assert.equal(result.goal.status, 'active');
    });

    it('pauseGoal: should reject non-active goal', async () => {
      const r = await goalStore.createGoal({
        title: 'Transitions - reject pause', description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      // Already submitted — can't pause.
      try {
        await goalStore.pauseGoal(r.goal.goal_id);
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('must be active'));
      }
    });

    it('startGoal: should reject non-approved/paused/review goal', async () => {
      const r = await goalStore.createGoal({
        title: 'Transitions - reject start', description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      // submitted → cannot start directly.
      try {
        await goalStore.startGoal(r.goal.goal_id);
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('must be approved'));
      }
    });
  });

  describe('archiveGoal()', () => {
    it('should archive a completed goal', async () => {
      const r = await goalStore.createGoal({
        title: 'Archive - completed',
        description: 'Testing archive flow.',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      await goalStore.updateGoal(r.goal.goal_id, { status: 'completed' });
      const result = await goalStore.archiveGoal(r.goal.goal_id);
      assert.ok(result.ok);
      assert.ok(result.archived);
      assert.equal(goalStore.getGoal(r.goal.goal_id), null);
    });

    it('should reject archive of non-completed/non-rejected goal', async () => {
      const r = await goalStore.createGoal({
        title: 'Archive - reject',
        description: '',
        workspace: TEST_WS, creatorUid: 'test-user-1',
      });
      try {
        await goalStore.archiveGoal(r.goal.goal_id);
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('must be completed or rejected'));
      }
    });
  });
});
