// Sprint 11: ptyScanner unit tests — TDD contract.
// Tests protocol parsing (@task, @done, @tasks, @agents, @help),
// edge cases (ANSI escape, partial lines), and command routing.
//
// If lib/ptyScanner.js does not exist yet, all tests skip gracefully.
// Run: node --test tests/ptyScanner.test.js

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── TDD guard ─────────────────────────────────────────────────────────

let ptyScanner = null;
let MODULE_MISSING = false;

try {
  ptyScanner = require('../lib/ptyScanner');
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    MODULE_MISSING = true;
  } else {
    throw e;
  }
}

function _guard(name, fn) {
  if (MODULE_MISSING) {
    if (typeof name === 'string') console.log('  ⏭  skipped: ' + name);
    return;
  }
  return fn();
}

function _describeIf(name, fn) {
  if (MODULE_MISSING) {
    describe(name, () => {
      test('(模块不存在 — TDD 合约模式)', () => {
        console.log('  ⚠  lib/ptyScanner.js 不存在。');
        console.log('  这些测试定义了预期 API 合约。实现模块后运行。');
      });
    });
    return;
  }
  describe(name, fn);
}

// ── Mock infrastructure (used when module exists) ─────────────────────

let tmpBase;
let mockQueue, mockStore, mockSessions, mockWebTerminal;

function resetMocks() {
  mockQueue = {
    sendTaskCalls: [],
    respondTaskCalls: [],
    listMyTasksCalls: [],
    sendTask: async function(opts) {
      this.sendTaskCalls.push(opts);
      return { ok: true, task: { task_id: 'mock-task-' + Date.now().toString(36) } };
    },
    respondTask: async function(taskId, uid, result) {
      this.respondTaskCalls.push({ taskId, uid, result });
      return { ok: true };
    },
    listMyTasks: function(uid) {
      this.listMyTasksCalls.push(uid);
      return [];
    },
  };

  mockStore = {
    agents: {},
    sessions: {},
    getAgent: function(uid) { return this.agents[uid] || null; },
    getSessionAgentUid: function(sid) { return this.sessions[sid] || null; },
    getSessionByAgentUid: function(uid) {
      for (const [sid, auid] of Object.entries(this.sessions)) {
        if (auid === uid) return sid;
      }
      return null;
    },
    listAgentsInWorkspace: function() { return Object.values(this.agents); },
    listAllAgents: function() { return Object.values(this.agents); },
    findAgentByNameWs: function(name, ws) {
      return Object.values(this.agents).find(
        (a) => a.name === name && a.workspace === ws,
      ) || null;
    },
    countPendingTasks: function() { return 0; },
  };

  mockSessions = {
    sessions: [],
    loadAll: async function() { return this.sessions; },
  };

  mockWebTerminal = {
    writeCalls: [],
    onDataHandlers: new Map(),
    list: function() { return []; },
    write: function(sid, text) {
      this.writeCalls.push({ sid, text });
    },
    onData: function(sid, handler) {
      this.onDataHandlers.set(sid, handler);
      return () => this.onDataHandlers.delete(sid);
    },
  };
}

function setupEnv() {
  tmpBase = path.join(os.tmpdir(), 'boos-ptyscan-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
}

function teardownEnv() {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}

const SENDER_UID = 'agent_test_sender_001';
const SESSION_ID = 'session-test-001';

function registerSender() {
  mockStore.agents[SENDER_UID] = {
    uid: SENDER_UID,
    name: '测试工程师',
    intro: '测试用 agent',
    workspace: 'boos',
    role: 'worker',
    capabilities: ['testing'],
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
  mockStore.sessions[SESSION_ID] = SENDER_UID;
}

function registerTarget(name, uid, caps = []) {
  mockStore.agents[uid] = {
    uid, name, intro: '',
    workspace: 'boos',
    role: 'worker',
    capabilities: caps,
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };
}

// Inject mocks and reload ptyScanner with mocked dependencies.
// Returns a fresh ptyScanner instance (or null if module missing).
function reloadWithMocks() {
  if (MODULE_MISSING) return null;

  // Unload existing modules from cache.
  const paths = ['../lib/webTerminal', '../lib/agentBus/queue',
    '../lib/agentBus/store', '../lib/persistedSessions', '../lib/ptyScanner'];
  for (const p of paths) {
    try { delete require.cache[require.resolve(p)]; } catch {}
  }

  // Inject mocks.
  try { require.cache[require.resolve('../lib/webTerminal')] = { exports: mockWebTerminal }; } catch {}
  try { require.cache[require.resolve('../lib/agentBus/queue')] = { exports: mockQueue }; } catch {}
  try { require.cache[require.resolve('../lib/agentBus/store')] = { exports: mockStore }; } catch {}
  try { require.cache[require.resolve('../lib/persistedSessions')] = { exports: mockSessions }; } catch {}

  // Load ptyScanner with mocked deps.
  return require('../lib/ptyScanner');
}

function unloadMocks() {
  const paths = ['../lib/webTerminal', '../lib/agentBus/queue',
    '../lib/agentBus/store', '../lib/persistedSessions', '../lib/ptyScanner'];
  for (const p of paths) {
    try { delete require.cache[require.resolve(p)]; } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Module structure tests (no mocks needed)
// ═══════════════════════════════════════════════════════════════════════

_describeIf('ptyScanner — 模块结构', () => {
  test('导出 executeCommand', () => {
    _guard('executeCommand', () => {
      assert.equal(typeof ptyScanner.executeCommand, 'function');
    });
  });
  test('导出 scan', () => {
    _guard('scan', () => {
      assert.equal(typeof ptyScanner.scan, 'function');
    });
  });
  test('导出 start / stop', () => {
    _guard('start/stop', () => {
      assert.equal(typeof ptyScanner.start, 'function');
      assert.equal(typeof ptyScanner.stop, 'function');
    });
  });
  test('导出 scanCount / commandCount', () => {
    _guard('scanCount/commandCount', () => {
      assert.equal(typeof ptyScanner.scanCount, 'number');
      assert.equal(typeof ptyScanner.commandCount, 'number');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// executeCommand tests (with mock injection)
// ═══════════════════════════════════════════════════════════════════════

_describeIf('ptyScanner — @task 协议', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  beforeEach(() => {
    mockQueue.sendTaskCalls = [];
    mockQueue.respondTaskCalls = [];
    mockWebTerminal.writeCalls = [];
  });

  test('@task <agent-name> <content> → 路由 sendTask 且参数正确', async () => {
    registerTarget('前端工程师', 'agent_target_fe');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 前端工程师 修复按钮样式');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls.length, 1);
    const call = mockQueue.sendTaskCalls[0];
    assert.equal(call.receiver_uid, 'agent_target_fe');
    assert.equal(call.content, '修复按钮样式');
    assert.equal(call.sender.uid, SENDER_UID);
  });

  test('@task multi-word content → 保留完整', async () => {
    registerTarget('全栈架构师', 'agent_target_pm');

    await scanner.executeCommand(SESSION_ID,
      '@task 全栈架构师 请修复 server.js 中的第 42 行 bug');

    const call = mockQueue.sendTaskCalls[0];
    assert.ok(call.content.includes('server.js'));
    assert.ok(call.content.includes('第 42 行'));
  });

  test('@task 未知 target → 返回 error', async () => {
    const result = await scanner.executeCommand(SESSION_ID,
      '@task 不存在的Agent 做点事');

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('不存在的Agent'));
  });

  test('@task 给自己 → 返回 error', async () => {
    registerTarget('测试工程师', SENDER_UID);

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 测试工程师 测试');

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('yourself'));
  });

  test('@task 缺 target → 返回 error', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@task');

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('missing'));
  });

  test('@task target only → 以 "(empty task)" 发送', async () => {
    registerTarget('前端工程师', 'agent_target_fe');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 前端工程师');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls[0].content, '(empty task)');
  });

  test('@TASK 大写 → 不触发 (unknown command)', async () => {
    const result = await scanner.executeCommand(SESSION_ID,
      '@TASK 前端工程师 做XXX');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown command');
  });
});

_describeIf('ptyScanner — @done 协议', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  beforeEach(() => {
    mockQueue.respondTaskCalls = [];
  });

  test('@done <taskId> <result> → 调用 respondTask 参数正确', async () => {
    const result = await scanner.executeCommand(SESSION_ID,
      '@done task-abc123 完成啦');

    assert.ok(result.ok);
    assert.equal(mockQueue.respondTaskCalls.length, 1);
    const call = mockQueue.respondTaskCalls[0];
    assert.equal(call.taskId, 'task-abc123');
    assert.equal(call.result, '完成啦');
    assert.equal(call.uid, SENDER_UID);
  });

  test('@done multi-word result → 完整保留', async () => {
    await scanner.executeCommand(SESSION_ID,
      '@done task-xyz789 测试全部通过 覆盖率 85%');

    const call = mockQueue.respondTaskCalls[0];
    assert.equal(call.taskId, 'task-xyz789');
    assert.ok(call.result.includes('覆盖率 85%'));
  });

  test('@done 缺 taskId → 返回 error', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@done');

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('missing'));
  });

  test('@done taskId only → result 默认 "Done."', async () => {
    const result = await scanner.executeCommand(SESSION_ID,
      '@done task-only-id');

    assert.ok(result.ok);
    assert.equal(mockQueue.respondTaskCalls[0].result, 'Done.');
  });
});

_describeIf('ptyScanner — @tasks / @agents / @help', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  test('@tasks → 返回 ok', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@tasks');
    assert.ok(result.ok);
  });

  test('@tasks 带额外文本 → unknown command（需精确匹配）', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@tasks pending');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown command');
  });

  test('@agents → 返回 ok', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@agents');
    assert.ok(result.ok);
  });

  test('@help → 返回 ok', async () => {
    const result = await scanner.executeCommand(SESSION_ID, '@help');
    assert.ok(result.ok);
  });

  test('@help → 向 PTY 写入帮助文本', async () => {
    await scanner.executeCommand(SESSION_ID, '@help');
    const writes = mockWebTerminal.writeCalls.filter(
      (w) => w.sid === SESSION_ID,
    );
    assert.ok(writes.length >= 1, 'help should write to PTY');
    assert.ok(writes[0].text.includes('BNTP'), 'should mention BNTP');
    assert.ok(writes[0].text.includes('@task'), 'should document @task');
  });
});

_describeIf('ptyScanner — 非命令输入', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  test('普通文本 → unknown command', async () => {
    const r = await scanner.executeCommand(SESSION_ID, 'hello world');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown command');
  });

  test('空字符串 → empty command', async () => {
    const r = await scanner.executeCommand(SESSION_ID, '');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'empty command');
  });

  test('仅空白 → empty command', async () => {
    const r = await scanner.executeCommand(SESSION_ID, '   ');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'empty command');
  });

  test('@ 开头但非命令 → unknown command', async () => {
    const r = await scanner.executeCommand(SESSION_ID, '@blah test');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown command');
  });
});

_describeIf('ptyScanner — session 解析', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  test('未绑定 session → sender not bound', async () => {
    const r = await scanner.executeCommand('unknown-session', '@tasks');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('sender not bound'));
  });

  test('已绑定 session → 正确解析 sender', async () => {
    const r = await scanner.executeCommand(SESSION_ID, '@help');
    assert.ok(r.ok);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// scan() — line buffering
// ═══════════════════════════════════════════════════════════════════════

_describeIf('ptyScanner scan() — 行缓冲', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  test('部分行（无换行符）→ 缓冲，不路由', () => {
    const before = scanner.commandCount;
    scanner.scan(SESSION_ID, '@task 前端');
    assert.equal(scanner.commandCount, before,
      'partial line should buffer, not route');
  });

  test('缓冲拼接后完整行 → 触发路由', () => {
    const before = scanner.commandCount;
    scanner.scan(SESSION_ID, '@task 前端');
    scanner.scan(SESSION_ID, '工程师 做XXX\n');
    assert.equal(scanner.commandCount, before + 1,
      'concatenated line should trigger routing');
  });

  test('多行输入 → 分别计数', () => {
    const before = scanner.commandCount;
    scanner.scan(SESSION_ID, '@tasks\n@agents\n@help\n');
    assert.equal(scanner.commandCount, before + 3);
  });

  test('空行 → 忽略', () => {
    const before = scanner.commandCount;
    scanner.scan(SESSION_ID, '\n\n\n');
    assert.equal(scanner.commandCount, before);
  });

  test('scanCount 每次调用递增', () => {
    const before = scanner.scanCount;
    scanner.scan(SESSION_ID, 'hello\nworld\n');
    assert.equal(scanner.scanCount, before + 1);
  });

  test('buffer 跨多次 scan 拼接', () => {
    const before = scanner.commandCount;
    scanner.scan(SESSION_ID, 'hel');
    scanner.scan(SESSION_ID, 'lo ');
    scanner.scan(SESSION_ID, 'wor');
    assert.equal(scanner.commandCount, before, 'no newline → no routing');
    scanner.scan(SESSION_ID, 'ld\n');
    assert.equal(scanner.commandCount, before, 'plain text → no command');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════

_describeIf('ptyScanner — 边界情况', () => {
  let scanner;

  before(() => {
    setupEnv();
    resetMocks();
    registerSender();
    scanner = reloadWithMocks();
  });

  after(() => {
    unloadMocks();
    teardownEnv();
  });

  test('ANSI 转义序列 → 当前不匹配（已知限制）', async () => {
    const result = await scanner.executeCommand(SESSION_ID,
      '\x1b[32m@tasks\x1b[0m');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown command',
      'ANSI-escaped commands not yet supported (known limitation)');
  });

  test('target 名含特殊字符 → 正确匹配', async () => {
    registerTarget('全栈架构师_PM', 'agent_special');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 全栈架构师_PM 测试内容');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls[0].receiver_uid, 'agent_special');
  });

  test('target 含数字和连字符 → 正确匹配', async () => {
    registerTarget('agent-v2-test', 'agent_v2');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task agent-v2-test hello');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls[0].receiver_uid, 'agent_v2');
  });

  test('content 含 @ 符号 → 不二次触发', async () => {
    registerTarget('前端工程师', 'agent_fe');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 前端工程师 请参考 @done task-123 的结果');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls.length, 1,
      'only one sendTask should be called');
    assert.ok(mockQueue.sendTaskCalls[0].content.includes('@done'));
  });

  test('长内容 → 由 sendTask 截断至 4096', async () => {
    registerTarget('前端工程师', 'agent_fe');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 前端工程师 ' + 'A'.repeat(5000));

    assert.ok(result.ok);
    assert.ok(mockQueue.sendTaskCalls[0].content.length <= 4096);
  });

  test('target 中文+英文混合 → 正确匹配', async () => {
    registerTarget('前端FE工程师', 'agent_fe_mix');

    const result = await scanner.executeCommand(SESSION_ID,
      '@task 前端FE工程师 测试');

    assert.ok(result.ok);
    assert.equal(mockQueue.sendTaskCalls[0].receiver_uid, 'agent_fe_mix');
  });
});
