// dagDecomposer unit tests — Sprint 37.
//
// Tests the batch DAG decomposition module:
//   - Agent name→UID resolution
//   - Task title→ID dependency resolution
//   - Topological sort + cycle detection
//   - Atomic all-or-nothing creation
//   - suggestAssignments capability matching
//
// These tests use a dedicated test workspace to avoid polluting real data.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ── test setup ───────────────────────────────────────────────────────────

const TEST_WS = 'test-decompose';
const TEST_DB = path.join(require('../lib/agentBus/storeCore').DATA_DIR, 'agent-bus-test-decompose.json');
const REAL_DB = require('../lib/agentBus/storeCore').DB_PATH;

// Register test agents before each test.
const store = require('../lib/agentBus/store');
const dagDecomposer = require('../lib/agentBus/dagDecomposer');
const dagStore = require('../lib/agentBus/dagStore');

// Clear test DAGs after each test to avoid cross-test pollution.
async function cleanupTestDags() {
  const db = await store._load();
  if (db.dags) {
    for (const [id, d] of Object.entries(db.dags)) {
      if (d.workspace === TEST_WS) delete db.dags[id];
    }
  }
  if (db.dag_tasks) {
    for (const [id, t] of Object.entries(db.dag_tasks)) {
      if (t.dag_id && db.dags && !db.dags[t.dag_id]) {
        delete db.dag_tasks[id];
      }
    }
  }
  // Also clean up registry for test agents.
  try {
    const registry = require('../lib/agentBus/registry');
    const agents = registry.listAgentsInWorkspace(TEST_WS);
    for (const a of agents) {
      registry.deregisterAgent(a.uid);
    }
  } catch {}
}

// Register test agents (bypass registry to write directly to store, since
// we're testing dagDecomposer not the full MCP/registry stack).
async function registerTestAgents() {
  const { withFileLock } = require('../lib/agentBus/storeCore');
  const atomicWriteJson = require('../lib/atomicJson').atomicWriteJson;

  await withFileLock(REAL_DB, async () => {
    const db = await store._load();
    if (!db.agents) db.agents = {};
    if (!db.name_ws_index) db.name_ws_index = {};

    const agents = [
      { uid: 'test-pm-uid', name: 'PM-Test', intro: 'PM', workspace: TEST_WS, role: 'supervisor', capabilities: ['architecture', 'backend'], project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
      { uid: 'test-fe-uid', name: '前端工程师-Test', intro: 'FE', workspace: TEST_WS, role: 'worker', capabilities: ['frontend', 'react', 'css'], project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
      { uid: 'test-be-uid', name: '后端工程师-Test', intro: 'BE', workspace: TEST_WS, role: 'worker', capabilities: ['backend', 'nodejs', 'database'], project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
      { uid: 'test-qa-uid', name: '测试工程师-Test', intro: 'QA', workspace: TEST_WS, role: 'worker', capabilities: ['testing', 'e2e', 'security-audit'], project: null, pm_of: [], registered_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
    ];

    for (const a of agents) {
      db.agents[a.uid] = a;
      db.name_ws_index[`${a.name}|${TEST_WS}`] = a.uid;
    }
    await atomicWriteJson(REAL_DB, db);
  });
}

// ── tests ────────────────────────────────────────────────────────────────

describe('dagDecomposer', () => {
  before(async () => {
    await registerTestAgents();
  });

  after(async () => {
    await cleanupTestDags();
    // Remove test agents.
    const { withFileLock } = require('../lib/agentBus/storeCore');
    const atomicWriteJson = require('../lib/atomicJson').atomicWriteJson;
    await withFileLock(REAL_DB, async () => {
      const db = await store._load();
      const testUids = ['test-pm-uid', 'test-fe-uid', 'test-be-uid', 'test-qa-uid'];
      for (const uid of testUids) {
        if (db.agents[uid]) {
          const key = `${db.agents[uid].name}|${TEST_WS}`;
          delete db.name_ws_index[key];
          delete db.agents[uid];
        }
      }
      await atomicWriteJson(REAL_DB, db);
    });
  });

  // ── basic decomposition ────────────────────────────────────────────

  describe('decompose()', () => {
    it('should create a DAG with tasks using agent names', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Test Feature',
        description: 'Build a test feature end-to-end.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Design API',
            description: 'Design the REST API endpoints.',
            executor: '后端工程师-Test',
            reviewer: 'PM-Test',
            acceptance_criteria: 'API spec document with all endpoints defined.',
          },
          {
            title: 'Build UI',
            description: 'Build the React frontend.',
            executor: '前端工程师-Test',
            reviewer: 'PM-Test',
            acceptance_criteria: 'All UI components match mockups.',
          },
          {
            title: 'Write Tests',
            description: 'Write E2E tests.',
            executor: '测试工程师-Test',
            reviewer: '后端工程师-Test',
            dependencies: ['Design API', 'Build UI'],
            acceptance_criteria: '80%+ coverage on new code paths.',
          },
        ],
      });

      assert.ok(result.ok, 'decompose should succeed: ' + JSON.stringify(result));
      assert.ok(result.dag_id, 'should return dag_id');
      assert.equal(result.task_count, 3);
      assert.ok(result.auto_activated);
      assert.equal(result.activation.total, 3);

      // Verify DAG exists in store.
      const dag = dagStore.getDag(result.dag_id);
      assert.ok(dag, 'DAG should exist in store');
      assert.equal(dag.title, 'Test Feature');
      assert.equal(dag.status, 'active');
      assert.equal(dag.task_count, 3);

      // Verify tasks exist with correct assignments.
      const summary = dagStore.getDagSummary(result.dag_id);
      assert.equal(summary.total, 3);

      // Verify resolution report.
      assert.equal(result.resolution_report.length, 3);
      const designApi = result.resolution_report.find((r) => r.task_title === 'Design API');
      assert.ok(designApi);
      assert.ok(designApi.executor.includes('后端工程师-Test'));

      const writeTests = result.resolution_report.find((r) => r.task_title === 'Write Tests');
      assert.equal(writeTests.deps_count, 2);
    });

    it('should resolve executor/reviewer by UID directly', async () => {
      const result = await dagDecomposer.decompose({
        title: 'UID Test',
        description: 'Test direct UID references.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Task 1',
            description: 'Test task.',
            executor: 'test-fe-uid',
            reviewer: 'test-be-uid',
            acceptance_criteria: 'Works.',
          },
        ],
      });

      assert.ok(result.ok);
      assert.equal(result.resolution_report[0].executor.includes('前端工程师-Test'), true);
      assert.equal(result.resolution_report[0].reviewer.includes('后端工程师-Test'), true);
    });

    it('should reject executor and reviewer being the same agent', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Same Agent Test',
        description: 'Should fail.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Task 1',
            description: 'Test.',
            executor: '前端工程师-Test',
            reviewer: '前端工程师-Test',
            acceptance_criteria: 'N/A.',
          },
        ],
      });

      assert.equal(result.ok, false);
      assert.ok(
        result.error.includes('validation') ||
        (result.details && result.details.some((d) => d.includes('executor') && d.includes('reviewer'))),
        'should reject same executor/reviewer: ' + JSON.stringify(result)
      );
    });

    it('should reject unknown agent references', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Unknown Agent',
        description: 'Should fail.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Task 1',
            description: 'Test.',
            executor: 'nonexistent-agent',
            reviewer: 'PM-Test',
            acceptance_criteria: 'N/A.',
          },
        ],
      });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('agent resolution failed') || result.details?.[0]?.includes('not found'));
    });

    // ── dependency handling ───────────────────────────────────────────

    it('should create correct dependency chain', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Dependency Chain',
        description: 'Test topological dependency resolution.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Step 3: Deploy',
            description: 'Deploy to production.',
            executor: '后端工程师-Test',
            reviewer: 'PM-Test',
            dependencies: ['Step 2: Review'],
            acceptance_criteria: 'Deployment succeeds.',
          },
          {
            title: 'Step 1: Code',
            description: 'Write the code.',
            executor: '前端工程师-Test',
            reviewer: '后端工程师-Test',
            acceptance_criteria: 'Code compiles.',
          },
          {
            title: 'Step 2: Review',
            description: 'Code review.',
            executor: '后端工程师-Test',
            reviewer: 'PM-Test',
            dependencies: ['Step 1: Code'],
            acceptance_criteria: 'PR approved.',
          },
        ],
      });

      assert.ok(result.ok, 'chain should succeed: ' + JSON.stringify(result));
      assert.equal(result.task_count, 3);

      // Verify: Step 1 should be active (no deps), Step 2 pending (dep on 1), Step 3 pending (dep on 2).
      const dag = dagStore.getDag(result.dag_id);
      assert.equal(dag.status, 'active');

      const summary = dagStore.getDagSummary(result.dag_id);
      assert.equal(summary.active, 1, 'Step 1 should be active');
      assert.equal(summary.pending, 2, 'Steps 2&3 should be pending');
    });

    it('should detect circular dependencies', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Cycle Test',
        description: 'Should fail with cycle.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Task A',
            description: 'A depends on B.',
            executor: '前端工程师-Test',
            reviewer: 'PM-Test',
            dependencies: ['Task B'],
            acceptance_criteria: 'N/A.',
          },
          {
            title: 'Task B',
            description: 'B depends on A (cycle!).',
            executor: '后端工程师-Test',
            reviewer: 'PM-Test',
            dependencies: ['Task A'],
            acceptance_criteria: 'N/A.',
          },
        ],
      });

      assert.equal(result.ok, false);
      assert.ok(
        result.error.includes('circular') || result.error.includes('cycle'),
        'should report cycle: ' + result.error
      );
    });

    it('should warn on unresolvable dependency references', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Bad Dep Test',
        description: 'Dep that does not exist.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          {
            title: 'Task 1',
            description: 'References a non-existent dep.',
            executor: '前端工程师-Test',
            reviewer: 'PM-Test',
            dependencies: ['NonExistent Task'],
            acceptance_criteria: 'N/A.',
          },
        ],
      });

      assert.ok(result.ok, 'should still succeed with warning');
      assert.ok(result.warnings, 'should have warnings');
      assert.ok(result.warnings[0].includes('could not be resolved'));
    });

    // ── activation control ────────────────────────────────────────────

    it('should not activate when auto_activate=false', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Draft DAG',
        description: 'Stays in draft.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        autoActivate: false,
        tasks: [
          {
            title: 'Task 1',
            description: 'Test.',
            executor: '前端工程师-Test',
            reviewer: 'PM-Test',
            acceptance_criteria: 'N/A.',
          },
        ],
      });

      assert.ok(result.ok);
      assert.equal(result.auto_activated, false);
      const dag = dagStore.getDag(result.dag_id);
      assert.equal(dag.status, 'draft');
    });

    // ── input validation ──────────────────────────────────────────────

    it('should reject empty tasks array', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Empty',
        description: 'No tasks.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [],
      });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('non-empty'));
    });

    it('should reject missing required fields', async () => {
      const result = await dagDecomposer.decompose({
        title: 'Bad Tasks',
        description: 'Missing executor.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks: [
          { title: 'No Executor', description: 'Missing executor field.' },
        ],
      });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('validation'));
    });

    it('should reject too many tasks', async () => {
      const tasks = [];
      for (let i = 0; i < 51; i++) {
        tasks.push({
          title: `Task ${i}`,
          description: `Task ${i} description.`,
          executor: '前端工程师-Test',
          reviewer: 'PM-Test',
          acceptance_criteria: `AC ${i}`,
        });
      }
      const result = await dagDecomposer.decompose({
        title: 'Too Many',
        description: '51 tasks.',
        workspace: TEST_WS,
        createdBy: 'test-pm-uid',
        tasks,
      });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('max 50'));
    });
  });

  // ── suggestAssignments ──────────────────────────────────────────────

  describe('suggestAssignments()', () => {
    it('should match tasks to agents by capability', () => {
      const result = dagDecomposer.suggestAssignments(TEST_WS, [
        { title: 'Build UI', required_capabilities: ['frontend', 'react'] },
        { title: 'Build API', required_capabilities: ['backend', 'nodejs'] },
        { title: 'Write Tests', required_capabilities: ['testing', 'e2e'] },
      ]);

      assert.ok(result.ok);
      assert.equal(result.suggestions.length, 3);

      // UI → 前端工程师
      const uiSuggestion = result.suggestions.find((s) => s.title === 'Build UI');
      assert.ok(uiSuggestion);
      assert.equal(uiSuggestion.executor_name, '前端工程师-Test');

      // API → 后端工程师
      const apiSuggestion = result.suggestions.find((s) => s.title === 'Build API');
      assert.ok(apiSuggestion);
      assert.equal(apiSuggestion.executor_name, '后端工程师-Test');

      // Tests → 测试工程师
      const testSuggestion = result.suggestions.find((s) => s.title === 'Write Tests');
      assert.ok(testSuggestion);
      assert.equal(testSuggestion.executor_name, '测试工程师-Test');

      // Reviewers should be different from executors.
      assert.notEqual(uiSuggestion.reviewer_uid, uiSuggestion.executor_uid);
      assert.notEqual(apiSuggestion.reviewer_uid, apiSuggestion.executor_uid);
    });

    it('should return error for empty workspace', () => {
      const result = dagDecomposer.suggestAssignments('nonexistent-workspace', [
        { title: 'Task 1' },
      ]);

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('no agents'));
    });
  });

  // ── cleanup ─────────────────────────────────────────────────────────
  // Remove any test DAGs created during the test run.

  after(async () => {
    await cleanupTestDags();
  });
});
