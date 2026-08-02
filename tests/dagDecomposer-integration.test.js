'use strict';

// DAG Decomposer Integration Tests — Sprint 37
//
// Covers: dag_decompose + dag_suggest_assignments full MCP handler flow,
// dag_create/dag_add_task/dag_activate single-step regression,
// 50-task boundary, complex dependency chains, agent name→UID resolution,
// transaction rollback, and performance baseline.
//
// Uses the same pattern as handlers.test.js: temp BOOS_HOME, dispatch() via
// handlers.js for full-stack integration — single shared setup to avoid
// parallel-describe BOOS_HOME collisions.

const { test, describe, before, after } = require('node:test');
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
  '../lib/agentBus/dagStore', '../lib/agentBus/dagEngine',
  '../lib/agentBus/dagDecomposer', '../lib/agentBus/taskSystem',
  '../lib/agentBus/sleepManager',
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
  TMP = path.join(os.tmpdir(), 'boos-dag-int-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
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

// ── shared state (initialized once in beforeAll) ──────────────────────────────

let dispatch, dagStore;
let pmUid, pm2Uid, feUid, beUid, qaUid, workerA, workerB, zhSan, liSi, wangWu;

let _counter = 0;
function nextUid() {
  const n = String(++_counter).padStart(8, '0');
  return `tst-${n}-${n}-${n}-${n}${n}${n}${n}${n}${n}`;
}

async function _register(d, name, role, capabilities = []) {
  const uid = nextUid();
  const res = await d('register_agent', {
    name, intro: `${role}: ${name}`, workspace: 'boos-test',
    role, capabilities,
    cli_session_id: uid,
  }, { sessionId: 'sess-' + uid.slice(0, 12) });
  if (!res.ok) throw new Error(`register ${name} failed: ${JSON.stringify(res)}`);
  return uid;
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('DAG Decomposer Integration (Sprint 37)', () => {
  before(async () => {
    freshSetup();
    const handlers = require('../lib/agentBus/handlers');
    dispatch = handlers.dispatch;
    dagStore = require('../lib/agentBus/dagStore');

    pmUid   = await _register(dispatch, 'PM-Test',     'supervisor', ['architecture']);
    pm2Uid  = await _register(dispatch, 'PMO-Test',     'pmo');
    feUid   = await _register(dispatch, '前端工程师-Test', 'worker', ['frontend', 'react', 'css']);
    beUid   = await _register(dispatch, '后端工程师-Test', 'worker', ['backend', 'nodejs', 'database']);
    qaUid   = await _register(dispatch, '测试工程师-Test', 'worker', ['testing', 'e2e', 'security-audit']);
    workerA = await _register(dispatch, 'Worker-A',     'worker', ['backend']);
    workerB = await _register(dispatch, 'Worker-B',     'worker', ['frontend']);
    zhSan   = await _register(dispatch, '张三',          'worker', ['backend']);
    liSi    = await _register(dispatch, '李四',          'worker', ['frontend']);
    wangWu  = await _register(dispatch, '王五',          'worker', ['testing']);
  });

  after(() => { teardown(); });

  function pmCtx(uid) {
    return { uid: uid || pmUid, workspace: 'boos-test', sessionId: 'sess-pm', role: 'supervisor' };
  }

  // ── dag_decompose core flow ─────────────────────────────────────────────

  describe('dag_decompose core flow', () => {
    test('full flow: 3-task DAG with name-based agent refs', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Feature XYZ',
        description: 'Build end-to-end.',
        workspace: 'boos-test',
        tasks: [
          { title: 'Design API', description: 'Design REST endpoints.', executor: '后端工程师-Test', reviewer: 'PM-Test', acceptance_criteria: 'API spec.', },
          { title: 'Build UI', description: 'React components.', executor: '前端工程师-Test', reviewer: 'PM-Test', acceptance_criteria: 'Matches mockups.', },
          { title: 'Write Tests', description: 'E2E tests.', executor: '测试工程师-Test', reviewer: '后端工程师-Test', dependencies: ['Design API', 'Build UI'], acceptance_criteria: '80% cov.', },
        ],
      }, pmCtx());

      assert.ok(result.ok, 'should succeed: ' + JSON.stringify(result));
      assert.ok(result.dag_id);
      assert.strictEqual(result.task_count, 3);
      assert.strictEqual(result.resolution_report.length, 3);

      const dag = dagStore.getDag(result.dag_id);
      assert.ok(dag);
      assert.strictEqual(dag.status, 'active');
      assert.strictEqual(dag.task_count, 3);
      assert.ok(dag.task_sequence);
      assert.strictEqual(dag.task_sequence.length, 3);
    });

    test('resolves executor/reviewer by UID directly', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'UID Resolution', description: 'Direct UID refs.',
        workspace: 'boos-test',
        tasks: [{ title: 'Task 1', description: 'Test.', executor: feUid, reviewer: beUid, acceptance_criteria: 'Done.', }],
      }, pmCtx());

      assert.ok(result.ok);
      assert.ok(result.resolution_report[0].executor.includes('前端工程师'));
    });

    test('rejects same executor and reviewer', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Same Agent', description: 'Fail.',
        workspace: 'boos-test',
        tasks: [{ title: 'Self Review', description: 'Same.', executor: '前端工程师-Test', reviewer: '前端工程师-Test', acceptance_criteria: 'N/A.', }],
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok(result.error.includes('validation') || (result.details && result.details.some((d) => d.includes('same agent'))));
    });

    test('rejects unknown executor', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Unknown', description: 'Fail.',
        workspace: 'boos-test',
        tasks: [{ title: 'Ghost', description: 'Nope.', executor: 'GhostAgent', reviewer: 'PM-Test', acceptance_criteria: 'N/A.', }],
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok(result.details && result.details.some((d) => d.includes('not found')));
    });

    test('rejects empty tasks array', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Empty', description: 'No tasks.', workspace: 'boos-test', tasks: [],
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok(result.error.includes('non-empty'));
    });

    test('rejects missing executor and reviewer', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Missing', description: 'Fail.',
        workspace: 'boos-test',
        tasks: [{ title: 'No Exec' }],
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok(result.error.includes('validation'));
    });

    test('auto_activate=false keeps DAG in draft', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Draft DAG', description: 'Draft.', workspace: 'boos-test', auto_activate: false,
        tasks: [{ title: 'Draft Task', description: 'Draft.', executor: '前端工程师-Test', reviewer: 'PM-Test', acceptance_criteria: 'N/A.', }],
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.auto_activated, false);
      const dag = dagStore.getDag(result.dag_id);
      assert.strictEqual(dag.status, 'draft');
    });

    test('non-PM worker is rejected', async () => {
      const workerCtx = { uid: feUid, workspace: 'boos-test', sessionId: 'sess-fe', role: 'worker' };
      const result = await dispatch('dag_decompose', {
        title: 'Unauthorized', description: 'Should fail.', workspace: 'boos-test',
        tasks: [{ title: 'T1', description: 'd', executor: 'PM-Test', reviewer: '后端工程师-Test', acceptance_criteria: 'na' }],
      }, workerCtx);

      assert.ok(!result.ok);
      assert.ok(result.error && result.error.includes('role'));
    });
  });

  // ── dag_suggest_assignments ────────────────────────────────────────────

  describe('dag_suggest_assignments', () => {
    test('suggests assignments by capability matching', async () => {
      const ctx = { uid: feUid, workspace: 'boos-test', sessionId: 'sess-fe' };
      const result = await dispatch('dag_suggest_assignments', {
        workspace: 'boos-test',
        tasks: [
          { title: 'Build UI', required_capabilities: ['frontend', 'react'] },
          { title: 'Build API', required_capabilities: ['backend', 'nodejs'] },
          { title: 'Write Tests', required_capabilities: ['testing', 'e2e'] },
        ],
      }, ctx);

      assert.ok(result.ok);
      assert.strictEqual(result.suggestions.length, 3);
      assert.strictEqual(result.suggestions.find((s) => s.title === 'Build UI').executor_name, '前端工程师-Test');
      assert.strictEqual(result.suggestions.find((s) => s.title === 'Build API').executor_name, '后端工程师-Test');
      assert.strictEqual(result.suggestions.find((s) => s.title === 'Write Tests').executor_name, '测试工程师-Test');
    });

    test('suggested reviewers differ from executors', async () => {
      const ctx = { uid: feUid, workspace: 'boos-test', sessionId: 'sess-fe' };
      const result = await dispatch('dag_suggest_assignments', {
        workspace: 'boos-test',
        tasks: [
          { title: 'Task A', required_capabilities: ['frontend'] },
          { title: 'Task B', required_capabilities: ['backend'] },
        ],
      }, ctx);

      assert.ok(result.ok);
      for (const s of result.suggestions) {
        assert.notStrictEqual(s.reviewer_uid, s.executor_uid, `${s.title}: reviewer must differ`);
      }
    });

    test('returns error for empty workspace', async () => {
      const ctx = { uid: feUid, workspace: 'boos-test', sessionId: 'sess-fe' };
      const result = await dispatch('dag_suggest_assignments', {
        workspace: 'empty-workspace', tasks: [{ title: 'Ghost' }],
      }, ctx);

      assert.ok(!result.ok);
      assert.ok(result.error.includes('no agents'));
    });

    test('missing uid in ctx is rejected', async () => {
      const ctx = { workspace: 'boos-test', sessionId: 'sess-x' }; // No uid
      const result = await dispatch('dag_suggest_assignments', {
        workspace: 'boos-test', tasks: [{ title: 'Test' }],
      }, ctx);

      assert.ok(!result.ok);
      assert.ok(result.error.includes('registered'));
    });
  });

  // ── dag_create/dag_add_task/dag_activate regression ────────────────────

  describe('dag_create / dag_add_task / dag_activate regression', () => {
    test('full manual flow: create → add tasks → activate', async () => {
      const create = await dispatch('dag_create', {
        title: 'Manual DAG', description: 'Step by step.', workspace: 'boos-test',
      }, pmCtx());
      assert.ok(create.ok, 'dag_create: ' + JSON.stringify(create));
      const dagId = create.dag.dag_id;

      const t1 = await dispatch('dag_add_task', {
        dag_id: dagId, title: 'Step 1', description: 'First.',
        executor_uid: feUid, reviewer_uid: beUid, acceptance_criteria: 'Done.',
      }, pmCtx());
      assert.ok(t1.ok, 'add task 1: ' + JSON.stringify(t1));
      const t1Id = t1.task.task_id;

      const t2 = await dispatch('dag_add_task', {
        dag_id: dagId, title: 'Step 2', description: 'Second.',
        executor_uid: beUid, reviewer_uid: feUid,
        dependencies: [t1Id], acceptance_criteria: 'Done.',
      }, pmCtx());
      assert.ok(t2.ok, 'add task 2: ' + JSON.stringify(t2));

      const activate = await dispatch('dag_activate', { dag_id: dagId }, pmCtx());
      assert.ok(activate.status === 'active' || activate.ok, 'activate: ' + JSON.stringify(activate));

      const dag = dagStore.getDag(dagId);
      assert.strictEqual(dag.task_count, 2);
    });

    test('cannot add task to non-existent DAG', async () => {
      let err = null;
      try {
        await dispatch('dag_add_task', {
          dag_id: 'no-such-dag', title: 'Bad', description: 'Fail.',
          executor_uid: feUid, reviewer_uid: beUid, acceptance_criteria: 'N/A.',
        }, pmCtx());
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'non-existent DAG should throw');
      assert.ok(err.message.includes('not found'));
    });

    test('non-PM cannot create DAG', async () => {
      const workerCtx = { uid: feUid, workspace: 'boos-test', sessionId: 'sess-fe', role: 'worker' };
      const result = await dispatch('dag_create', {
        title: 'Unauthorized', description: 'Fail.',
      }, workerCtx);

      assert.ok(!result.ok);
    });

    test('dag_status for non-existent DAG returns error', async () => {
      const result = await dispatch('dag_status', { dag_id: 'no-such-dag' }, pmCtx());
      assert.ok(result.error !== undefined || result.dag === undefined);
    });

    test('dag_list returns DAGs in workspace', async () => {
      const create = await dispatch('dag_create', {
        title: 'List DAG', description: 'List me.', workspace: 'boos-test',
      }, pmCtx());
      assert.ok(create.ok);

      const list = await dispatch('dag_list', { workspace: 'boos-test' }, pmCtx());
      assert.ok(list.ok);
      assert.ok(list.count >= 1);
      assert.ok(Array.isArray(list.dags));
    });

    test('dag_cancel cancels a draft DAG', async () => {
      const create = await dispatch('dag_create', {
        title: 'Cancel Me', description: 'Going away.', workspace: 'boos-test',
      }, pmCtx());
      assert.ok(create.ok);

      const cancel = await dispatch('dag_cancel', {
        dag_id: create.dag.dag_id, reason: 'No longer needed.',
      }, pmCtx());

      assert.ok(cancel.ok);
      assert.strictEqual(cancel.status, 'cancelled');
    });
  });

  // ── 50-task boundary ───────────────────────────────────────────────────

  describe('dag_decompose 50-task limit', () => {
    test('accepts exactly 50 tasks', async () => {
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push({
          title: `T-${i}`, description: `Desc ${i}`, executor: 'Worker-A',
          reviewer: 'Worker-B', acceptance_criteria: `AC ${i}`,
        });
      }

      const result = await dispatch('dag_decompose', {
        title: '50 Tasks', description: 'Max.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.task_count, 50);
      assert.strictEqual(result.resolution_report.length, 50);
    });

    test('rejects 51 tasks', async () => {
      const tasks = [];
      for (let i = 0; i < 51; i++) {
        tasks.push({
          title: `OF-${i}`, description: `Desc ${i}`, executor: 'Worker-A',
          reviewer: 'Worker-B', acceptance_criteria: `AC ${i}`,
        });
      }

      const result = await dispatch('dag_decompose', {
        title: '51 Tasks', description: 'Overflow.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok(result.error.includes('max 50'));
    });
  });

  // ── complex dependency chains ──────────────────────────────────────────

  describe('dag_decompose complex dependencies', () => {
    test('deep linear chain of 10 tasks', async () => {
      const tasks = [];
      for (let i = 1; i <= 10; i++) {
        tasks.push({
          title: `Step ${i}`, description: `Step ${i}.`, executor: 'Worker-A',
          reviewer: 'Worker-B',
          dependencies: i > 1 ? [`Step ${i - 1}`] : [],
          acceptance_criteria: `Done ${i}.`,
        });
      }

      const result = await dispatch('dag_decompose', {
        title: '10-Link Chain', description: 'Linear.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.task_count, 10);

      const dag = dagStore.getDag(result.dag_id);
      const seq = dag.task_sequence;
      const step1 = seq.find((s) => s.title === 'Step 1');
      assert.strictEqual(step1.deps.length, 0);
      const step10 = seq.find((s) => s.title === 'Step 10');
      assert.strictEqual(step10.deps.length, 1);
    });

    test('diamond dependency: 1→2,3→4', async () => {
      const tasks = [
        { title: 'Start',    description: 'Begin.',       executor: 'Worker-A', reviewer: 'Worker-B', acceptance_criteria: 'Done.', },
        { title: 'Branch A', description: 'Left.',        executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['Start'], acceptance_criteria: 'Done.', },
        { title: 'Branch B', description: 'Right.',       executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['Start'], acceptance_criteria: 'Done.', },
        { title: 'Merge',    description: 'Combine.',     executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['Branch A', 'Branch B'], acceptance_criteria: 'Done.', },
      ];

      const result = await dispatch('dag_decompose', {
        title: 'Diamond', description: 'Parallel.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.task_count, 4);
    });

    test('detects cyclic dependencies', async () => {
      const tasks = [
        { title: 'A', description: 'A→B.', executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['B'], acceptance_criteria: 'N/A.', },
        { title: 'B', description: 'B→A.', executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['A'], acceptance_criteria: 'N/A.', },
      ];

      const result = await dispatch('dag_decompose', {
        title: 'Cycle', description: 'Fail.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(!result.ok);
      assert.ok((result.error || '').includes('circular') || (result.error || '').includes('cycle') ||
        (result.details && result.details.some((d) => d.includes('circular'))));
    });
  });

  // ── transaction rollback ────────────────────────────────────────────────

  describe('dag_decompose transaction rollback', () => {
    test('no partial DAG after agent resolution failure', async () => {
      const tasks = [
        { title: 'Valid', description: 'OK.', executor: 'Worker-A', reviewer: 'Worker-B', acceptance_criteria: 'Done.', },
        { title: 'Bad', description: 'Fail.', executor: 'NonExistentAgent', reviewer: 'Worker-B', acceptance_criteria: 'N/A.', },
      ];

      const result = await dispatch('dag_decompose', {
        title: 'Rollback 1', description: 'Partial rollback.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(!result.ok);
      const allDags = dagStore.listDags('boos-test');
      assert.strictEqual(allDags.find((d) => d.title === 'Rollback 1'), undefined);
    });

    test('no tasks persisted on cycle failure', async () => {
      const tasks = [
        { title: 'T-X', description: 'X.', executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['T-Y'], acceptance_criteria: 'N/A.', },
        { title: 'T-Y', description: 'Y.', executor: 'Worker-A', reviewer: 'Worker-B', dependencies: ['T-X'], acceptance_criteria: 'N/A.', },
      ];

      const result = await dispatch('dag_decompose', {
        title: 'Cycle Rollback', description: 'Fail.', workspace: 'boos-test', tasks,
      }, pmCtx());

      assert.ok(!result.ok);
      const allDags = dagStore.listDags('boos-test');
      assert.strictEqual(allDags.find((d) => d.title === 'Cycle Rollback'), undefined);
    });
  });

  // ── performance baseline ────────────────────────────────────────────────

  describe('dag_decompose performance', () => {
    test('50-task DAG within 2 seconds', async () => {
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push({
          title: `P-${i}`, description: `Perf ${i}.`,
          executor: i % 2 === 0 ? 'Worker-A' : 'Worker-B',
          reviewer: i % 2 === 0 ? 'Worker-B' : 'Worker-A',
          acceptance_criteria: `AC ${i}`,
        });
      }

      const start = Date.now();
      const result = await dispatch('dag_decompose', {
        title: 'Perf 50', description: 'Performance run.', workspace: 'boos-test', tasks,
      }, pmCtx());
      const elapsed = Date.now() - start;

      assert.ok(result.ok);
      assert.ok(elapsed < 2000, `50-task took ${elapsed}ms (limit: 2000ms)`);
    });

    test('10-task deep chain within 500ms', async () => {
      const tasks = [];
      for (let i = 1; i <= 10; i++) {
        tasks.push({
          title: `Chain ${i}`, description: `Step ${i}.`, executor: 'Worker-A',
          reviewer: 'Worker-B',
          dependencies: i > 1 ? [`Chain ${i - 1}`] : [],
          acceptance_criteria: `OK ${i}.`,
        });
      }

      const start = Date.now();
      const result = await dispatch('dag_decompose', {
        title: 'Chain Perf', description: 'Deep chain.', workspace: 'boos-test', tasks,
      }, pmCtx());
      const elapsed = Date.now() - start;

      assert.ok(result.ok);
      assert.ok(elapsed < 500, `10-chain took ${elapsed}ms (limit: 500ms)`);
    });
  });

  // ── edge cases ──────────────────────────────────────────────────────────

  describe('dag_decompose edge cases', () => {
    test('handles CJK (Unicode) agent names', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'CJK Names', description: 'Unicode test.', workspace: 'boos-test',
        tasks: [
          { title: 'CJK Task', description: 'Test.', executor: '张三', reviewer: '李四', acceptance_criteria: 'OK.', },
        ],
      }, pmCtx());

      assert.ok(result.ok, JSON.stringify(result).slice(0, 200));
      assert.strictEqual(result.resolution_report.length, 1);
    });

    test('warns on unresolvable dependency references', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Bad Dep', description: 'Unresolvable dep.', workspace: 'boos-test',
        tasks: [
          { title: 'Solo', description: 'Has phantom dep.', executor: '张三', reviewer: '李四',
            dependencies: ['PhantomTask'], acceptance_criteria: 'Still OK.', },
        ],
      }, pmCtx());

      assert.ok(result.ok);
      assert.ok(result.warnings);
      assert.ok(result.warnings.some((w) => w.includes('could not be resolved')));
    });

    test('single-task DAG with no dependencies', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Solo DAG', description: 'Just one.', workspace: 'boos-test',
        tasks: [
          { title: 'Only', description: 'The only task.', executor: '张三', reviewer: '李四', acceptance_criteria: 'Done.', },
        ],
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.task_count, 1);
      assert.strictEqual(result.resolution_report[0].deps_count, 0);
    });

    test('handles priority field on tasks', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Priority DAG', description: 'Priorities.', workspace: 'boos-test',
        tasks: [
          { title: 'Urgent', description: 'High.', executor: '张三', reviewer: '李四', priority: 'high', acceptance_criteria: 'ASAP.', },
          { title: 'Chill', description: 'Low.', executor: '李四', reviewer: '张三', priority: 'low', acceptance_criteria: 'Later.', },
        ],
      }, pmCtx());

      assert.ok(result.ok);
      assert.strictEqual(result.task_count, 2);
    });

    test('handles custom max_retries', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Retry DAG', description: 'Custom retries.', workspace: 'boos-test',
        tasks: [
          { title: 'Retry', description: '5 retries.', executor: '张三', reviewer: '李四', max_retries: 5, acceptance_criteria: 'OK.', },
        ],
      }, pmCtx());

      assert.ok(result.ok);
    });

    test('handles acceptance_criteria without description', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'AC Only', description: 'No desc.', workspace: 'boos-test',
        tasks: [
          { title: 'Minimal', executor: '张三', reviewer: '李四', acceptance_criteria: 'Enough.', },
        ],
      }, pmCtx());

      assert.ok(result.ok);
    });

    test('handles special characters in task titles', async () => {
      const result = await dispatch('dag_decompose', {
        title: 'Special Chars', description: 'Special chars in titles.', workspace: 'boos-test',
        tasks: [
          { title: 'Fix login bug [URGENT] (v2.0)', description: 'Has brackets and parens.',
            executor: '张三', reviewer: '李四', acceptance_criteria: 'Fixed.', },
          { title: 'Email notification — user@example.com', description: 'Has @ and dash.',
            executor: '李四', reviewer: '张三', acceptance_criteria: 'Works.', },
        ],
      }, pmCtx());

      assert.ok(result.ok, JSON.stringify(result).slice(0, 200));
      assert.strictEqual(result.task_count, 2);
    });
  });
});
