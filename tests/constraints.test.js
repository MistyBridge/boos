// Sprint 12: Agent Hard Constraints Engine tests — R15.
// Tests C1-C6 rules: evaluate(), checkLimits(), workspaceStatus().
//
// Run: node --test tests/constraints.test.js

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── Setup ─────────────────────────────────────────────────────────────

let tmpBase;
let constraints, store;

before(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-constraints-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  try { delete require.cache[require.resolve('../lib/agentBus/store')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/constraints')]; } catch {}
  constraints = require('../lib/agentBus/constraints');
  store = require('../lib/agentBus/store');
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════
// C1: Auto-continue — confirmation questions auto-rejected
// ═══════════════════════════════════════════════════════════════════════

describe('C1: 自动确认 — 继续类问题自动拒绝', () => {
  test('"是否继续" → auto-reject, rule=C1', () => {
    const r = constraints.evaluate('request_decision', {
      content: '是否继续执行下一步？',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C1');
    assert.equal(r.auto_action, 'reject');
    assert.ok(r.reason.includes('C1'));
  });

  test('"要不要继续下一步" → auto-reject', () => {
    const r = constraints.evaluate('request_decision', {
      content: '要不要继续下一步的修改？',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C1');
  });

  test('"还要不要接着做" → auto-reject', () => {
    const r = constraints.evaluate('request_decision', {
      content: '还要不要接着做 unit tests？',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C1');
  });

  test('"Should I continue" (English) → auto-reject', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Should I continue with the refactoring?',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C1');
  });

  test('"继续吗" → auto-reject', () => {
    const r = constraints.evaluate('request_decision', {
      content: '继续吗？',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C1');
  });

  test('真实业务问题 → 不匹配 C1', () => {
    const r = constraints.evaluate('request_decision', {
      content: '数据库选型使用 PostgreSQL 还是 MySQL？',
      agent_uid: 'agent_test_c1',
    });
    // Should pass through to C4 (real blocker).
    assert.equal(r.pass, true);
    assert.equal(r.rule, 'C4');
  });

  test('技术方案选择 → 不匹配 C1', () => {
    const r = constraints.evaluate('request_decision', {
      content: '架构方案 A：微服务 vs 方案 B：单体，选哪个？',
      agent_uid: 'agent_test_c1',
    });
    assert.equal(r.pass, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C2: Error auto-retry — same error retry ≤ 2 → auto-retry
// ═══════════════════════════════════════════════════════════════════════

describe('C2: 错误自动重试 — 同类错误最多重试 2 次', () => {
  test('首次 ENOENT 错误 (retry_count=0) → auto-retry', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: ENOENT',
      agent_uid: 'agent_c2',
      task_id: 'task-c2-001',
      retry_count: 0,
      error_type: 'ENOENT',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C2');
    assert.equal(r.auto_action, 'retry');
    assert.ok(r.reason.includes('重试 #1'));
  });

  test('第 2 次同类错误 (retry_count=1) → auto-retry', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: ENOENT again',
      agent_uid: 'agent_c2',
      task_id: 'task-c2-001',
      retry_count: 1,
      error_type: 'ENOENT',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C2');
    assert.ok(r.reason.includes('重试 #2'));
  });

  test('第 3 次同类错误 (retry_count=2) → C2 重试耗尽, 落入 C3', () => {
    // C2 internal counter: attempts reaches 3, 3 <= 2 is false.
    // Content "ENOENT" then matches C3.
    const r = constraints.evaluate('request_decision', {
      content: 'Error: ENOENT third time',
      agent_uid: 'agent_c2',
      task_id: 'task-c2-001',
      retry_count: 2,
      error_type: 'ENOENT',
    });
    // C2 exhausted → C3 picks up (ENOENT in content).
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
    assert.ok(r.reason.includes('missing_file'));
  });

  test('第 4 次 (retry_count=3) → 不进入 C2, 超过上限', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: ENOENT',
      agent_uid: 'agent_c2',
      task_id: 'task-c2-001',
      retry_count: 3,
      error_type: 'ENOENT',
    });
    // retry_count > 2 → C2 condition fails → fall through to C3/C4.
    assert.ok(r.rule !== 'C2');
  });

  test('不同 task_id 的同类错误 → 独立计数', () => {
    // First task, first error.
    const r1 = constraints.evaluate('request_decision', {
      content: 'ECONNREFUSED',
      agent_uid: 'agent_c2b',
      task_id: 'task-c2-diff-1',
      retry_count: 0,
      error_type: 'ECONNREFUSED',
    });
    assert.equal(r1.rule, 'C2');

    // Different task, first error → should still retry (independent).
    const r2 = constraints.evaluate('request_decision', {
      content: 'ECONNREFUSED',
      agent_uid: 'agent_c2b',
      task_id: 'task-c2-diff-2',
      retry_count: 0,
      error_type: 'ECONNREFUSED',
    });
    assert.equal(r2.rule, 'C2', 'different task should have independent retry count');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C3: Clear error auto-fix — ENOENT/missing dep/permission/etc
// ═══════════════════════════════════════════════════════════════════════

describe('C3: 清晰错误自动修复', () => {
  test('ENOENT error → auto-fix, rule=C3', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: ENOENT: no such file or directory',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
    assert.equal(r.auto_action, 'reject');
    assert.ok(r.reason.includes('missing_file'));
  });

  test('Cannot find module → auto-fix', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: Cannot find module "express"',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
    assert.equal(r.reason, 'C3: 清晰错误可自动修复 — missing_dependency');
  });

  test('EACCES permission denied → auto-fix', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'EACCES: permission denied, open config.json',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
    assert.equal(r.reason, 'C3: 清晰错误可自动修复 — permission');
  });

  test('Syntax error → auto-fix', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'SyntaxError: Unexpected token }',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
  });

  test('is not a function → auto-fix', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'TypeError: undefined is not a function',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
  });

  test('ECONNREFUSED → auto-fix', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'Error: connect ECONNREFUSED 127.0.0.1:8080',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, false);
    assert.equal(r.rule, 'C3');
  });

  test('普通内容（非可修复错误） → pass through', () => {
    const r = constraints.evaluate('request_decision', {
      content: '应该使用哪种认证方案？',
      agent_uid: 'agent_c3',
    });
    assert.equal(r.pass, true);
    assert.equal(r.rule, 'C4');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C4: Real blocker — normal decision flow
// ═══════════════════════════════════════════════════════════════════════

describe('C4: 真实阻碍 — 正常决策流程', () => {
  test('非 C1/C2/C3 的决策 → pass through with rule=C4', () => {
    const r = constraints.evaluate('request_decision', {
      content: '需要确认 API 版本号：v1 还是 v2？',
      agent_uid: 'agent_c4',
    });
    assert.equal(r.pass, true);
    assert.equal(r.rule, 'C4');
  });

  test('技术栈选型 → pass through', () => {
    const r = constraints.evaluate('request_decision', {
      content: '前端框架选择 React 还是 Vue？',
      agent_uid: 'agent_c4',
    });
    assert.equal(r.pass, true);
  });

  test('资源分配决策 → pass through', () => {
    const r = constraints.evaluate('request_decision', {
      content: '应该优先开发 A 功能还是 B 功能？',
      agent_uid: 'agent_c4',
    });
    assert.equal(r.pass, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C5: Concurrency cap — max 3 in_progress per agent
// ═══════════════════════════════════════════════════════════════════════

describe('C5: 并发上限 — 每 agent 最多 3 个 in_progress', () => {
  let agentUid;

  before(async () => {
    agentUid = 'agent_c5_test';
    // Register agent.
    try { await store.deleteAgent(agentUid); } catch {}
    await store.insertAgent({
      uid: agentUid, name: 'C5测试', intro: '', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
    });
  });

  after(async () => {
    try { await store.deleteAgent(agentUid); } catch {}
  });

  test('0 in_progress → can_accept = true', () => {
    const r = constraints.checkLimits(agentUid);
    assert.equal(r.can_accept, true);
    assert.equal(r.in_progress_count, 0);
    assert.equal(r.max, 3);
  });

  test('3 in_progress → can_accept = false (at cap)', async () => {
    // Insert 3 in_progress tasks.
    const taskIds = [];
    for (let i = 0; i < 3; i++) {
      const tid = 'c5_task_' + i + '_' + Date.now().toString(36);
      await store.insertTask({
        task_id: tid,
        sender_uid: 'any', sender_name: 's', sender_intro: '',
        receiver_uid: agentUid, content: 'test', priority: 'normal',
        status: 'in_progress', created_at: new Date().toISOString(),
      });
      taskIds.push(tid);
    }

    const r = constraints.checkLimits(agentUid);
    assert.equal(r.can_accept, false);
    assert.equal(r.in_progress_count, 3);
    assert.ok(r.reason.includes('C5'));
    assert.ok(r.reason.includes('3/3'));

    // Cleanup.
    for (const tid of taskIds) {
      try { await store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
    }
  });

  test('2 in_progress → can_accept = true', async () => {
    const taskIds = [];
    for (let i = 0; i < 2; i++) {
      const tid = 'c5_2_' + i + '_' + Date.now().toString(36);
      await store.insertTask({
        task_id: tid,
        sender_uid: 'any', sender_name: 's', sender_intro: '',
        receiver_uid: agentUid, content: 'test', priority: 'normal',
        status: 'in_progress', created_at: new Date().toISOString(),
      });
      taskIds.push(tid);
    }

    const r = constraints.checkLimits(agentUid);
    assert.equal(r.can_accept, true);
    assert.equal(r.in_progress_count, 2);

    for (const tid of taskIds) {
      try { await store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
    }
  });

  test('4 in_progress → can_accept = false (超过上限)', async () => {
    const taskIds = [];
    for (let i = 0; i < 4; i++) {
      const tid = 'c5_4_' + i + '_' + Date.now().toString(36);
      await store.insertTask({
        task_id: tid,
        sender_uid: 'any', sender_name: 's', sender_intro: '',
        receiver_uid: agentUid, content: 'test', priority: 'normal',
        status: 'in_progress', created_at: new Date().toISOString(),
      });
      taskIds.push(tid);
    }

    const r = constraints.checkLimits(agentUid);
    assert.equal(r.can_accept, false);
    assert.equal(r.in_progress_count, 4);
    assert.ok(r.reason.includes('4/3'));

    for (const tid of taskIds) {
      try { await store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C6: Quiet period merge — max 3 decisions per 10min
// ═══════════════════════════════════════════════════════════════════════

describe('C6: 静默期合并 — 10 分钟内最多 3 个独立决策', () => {
  test('第 1 个决策 → pass through (rule=C4)', () => {
    const r = constraints.evaluate('request_decision', {
      content: '需要确认数据库选型',
      agent_uid: 'agent_c6_test_1',
    });
    // First decision — passes through to C4.
    assert.equal(r.pass, true);
    assert.equal(r.rule, 'C4');
  });

  test('C6 规则在 4 个决策后返回 merge_group', () => {
    const uid = 'agent_c6_test_2';

    // Decisions 1-3 pass through normally.
    for (let i = 0; i < 3; i++) {
      const r = constraints.evaluate('request_decision', {
        content: '决策 ' + (i + 1),
        agent_uid: uid,
      });
      assert.equal(r.pass, true, 'decision #' + (i + 1) + ' should pass');
    }

    // Decision 4 → C6 merge triggered.
    const r4 = constraints.evaluate('request_decision', {
      content: '第 4 个决策',
      agent_uid: uid,
    });
    assert.equal(r4.pass, true, 'pass is true for C6 (still allowed through)');
    assert.equal(r4.rule, 'C6');
    assert.ok(r4.merge_group, 'should have merge_group');
    assert.ok(r4.merge_group.startsWith(uid), 'merge_group should include uid');
    assert.ok(r4.reason.includes('C6'), 'reason should mention C6');
  });

  test('无 agent_uid → C6 不触发', () => {
    const r = constraints.evaluate('request_decision', {
      content: '需要确认方案',
      // No agent_uid provided.
    });
    assert.ok(r.pass);
    assert.ok(r.rule !== 'C6');
  });

  test('merge_group 格式包含时间窗口 key', () => {
    const uid = 'agent_c6_test_3';

    // Generate 4 decisions to trigger C6.
    for (let i = 0; i < 3; i++) {
      constraints.evaluate('request_decision', {
        content: 'decision ' + i, agent_uid: uid,
      });
    }
    const r = constraints.evaluate('request_decision', {
      content: 'decision 4', agent_uid: uid,
    });

    assert.equal(r.rule, 'C6');
    // merge_group format: "<uid>::<YYYYMMDDHHMM>"
    const parts = r.merge_group.split('::');
    assert.equal(parts.length, 2);
    assert.equal(parts[0], uid);
    assert.ok(/^\d{12}$/.test(parts[1]), 'window key should be 12 digits');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// workspaceStatus
// ═══════════════════════════════════════════════════════════════════════

describe('workspaceStatus', () => {
  let agent1, agent2;

  before(async () => {
    agent1 = 'agent_ws_c5_1';
    agent2 = 'agent_ws_c5_2';
    try { await store.deleteAgent(agent1); } catch {}
    try { await store.deleteAgent(agent2); } catch {}
    await store.insertAgent({
      uid: agent1, name: 'Agent1', intro: '', workspace: 'boos-ws',
      role: 'worker', capabilities: ['test'],
    });
    await store.insertAgent({
      uid: agent2, name: 'Agent2', intro: '', workspace: 'boos-ws',
      role: 'worker', capabilities: ['test'],
    });
  });

  after(async () => {
    try { await store.deleteAgent(agent1); } catch {}
    try { await store.deleteAgent(agent2); } catch {}
  });

  test('返回 workspace 内所有 agent 的状态', () => {
    const status = constraints.workspaceStatus('boos-ws');
    assert.ok(status.length >= 2);
    const a1 = status.find((s) => s.uid === agent1);
    assert.ok(a1, 'should include agent1');
    assert.equal(a1.in_progress, 0);
    assert.equal(a1.max, 3);
    assert.equal(a1.can_accept, true);
    assert.deepEqual(a1.blocked_rules, []);
  });

  test('达到并发上限的 agent → can_accept=false + blocked_rules 含 C5', async () => {
    // Give agent1 3 in_progress tasks.
    const taskIds = [];
    for (let i = 0; i < 3; i++) {
      const tid = 'ws_c5_t' + i + '_' + Date.now().toString(36);
      await store.insertTask({
        task_id: tid, sender_uid: 'any', sender_name: 's', sender_intro: '',
        receiver_uid: agent1, content: 'test', priority: 'normal',
        status: 'in_progress', created_at: new Date().toISOString(),
      });
      taskIds.push(tid);
    }

    const status = constraints.workspaceStatus('boos-ws');
    const a1 = status.find((s) => s.uid === agent1);
    assert.equal(a1.can_accept, false);
    assert.equal(a1.in_progress, 3);
    assert.ok(a1.blocked_rules.includes('C5'));

    for (const tid of taskIds) {
      try { await store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
    }
  });

  test('未达上限的 agent → can_accept=true', () => {
    const status = constraints.workspaceStatus('boos-ws');
    const a2 = status.find((s) => s.uid === agent2);
    assert.equal(a2.can_accept, true);
    assert.deepEqual(a2.blocked_rules, []);
  });

  test('空 workspace → 返回空数组', () => {
    const status = constraints.workspaceStatus('nonexistent-ws');
    // Should return empty array, not throw.
    assert.ok(Array.isArray(status));
    assert.equal(status.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('constraints — 边界情况', () => {
  test('action != "request_decision" → pass=true (不处理)', () => {
    const r = constraints.evaluate('send_task', {
      content: '是否继续？',
      agent_uid: 'test',
    });
    assert.equal(r.pass, true);
    // No rule assigned for non-decision actions.
    assert.equal(r.rule, undefined);
  });

  test('空 content → 不匹配任何规则', () => {
    const r = constraints.evaluate('request_decision', {
      content: '',
      agent_uid: 'test_empty',
    });
    assert.equal(r.pass, true);
    assert.equal(r.rule, 'C4');
  });

  test('C1 在 C2/C3 之前检查（中文确认 + 错误类型 → C1 优先）', () => {
    // Content matches both C1 (继续) and C3 (ENOENT).
    const r = constraints.evaluate('request_decision', {
      content: '是否继续？遇到 ENOENT 错误',
      agent_uid: 'agent_prio',
      task_id: 'task-prio',
      retry_count: 0,
      error_type: 'ENOENT',
    });
    // C1 is checked first in evaluate() → should win.
    assert.equal(r.rule, 'C1');
  });

  test('C2 在 C3 之前检查（有 error_type + retry_count → C2 优先）', () => {
    const r = constraints.evaluate('request_decision', {
      content: 'SyntaxError: Unexpected token',
      agent_uid: 'agent_c2_prio',
      task_id: 'task-c2-prio',
      retry_count: 1,
      error_type: 'SyntaxError',
    });
    // Content matches C3, but C2 is checked first.
    assert.equal(r.rule, 'C2');
  });

  test('未定义 agent_uid → 不触发 C6, 不影响 C1/C3', () => {
    // C1 still triggers even without agent_uid.
    const r = constraints.evaluate('request_decision', {
      content: '是否继续？',
    });
    assert.equal(r.rule, 'C1');
  });

  test('checkLimits 对未注册 agent → 返回空列表结果', () => {
    const r = constraints.checkLimits('nonexistent_uid');
    assert.equal(r.can_accept, true);
    assert.equal(r.in_progress_count, 0);
    assert.equal(r.pending_count, 0);
  });
});
