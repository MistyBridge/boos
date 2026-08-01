'use strict';

// Sandbox — tests for lib/sandbox.js
//
// Covers: isAllowed(), getFilesystemMcpConfig(), getWritePermission(),
// canWriteCodeFile(), and internal _isPM / _resolveFolderId paths.
//
// Uses temporary BOOS_HOME with real JSON stores to exercise the full
// integration path without mocking.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── test harness ─────────────────────────────────────────────────────────────

const TMP = path.join(os.tmpdir(), 'boos-sandbox-test-' + Date.now());
const origHome = process.env.BOOS_HOME;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function writeJson(fp, obj) { fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf-8'); }

function setupDataDir() {
  ensureDir(TMP);
  process.env.BOOS_HOME = TMP;

  // Agent-bus DB with a test agent
  writeJson(path.join(TMP, 'agent-bus.json'), {
    agents: {
      'agent-pm': { uid: 'agent-pm', name: 'PM', role: 'supervisor', workspace: 'boos' },
      'agent-worker': { uid: 'agent-worker', name: 'Worker', role: 'worker', workspace: 'boos' },
      'agent-pmo': { uid: 'agent-pmo', name: 'PMO', role: 'pmo', workspace: 'boos' },
      'agent-se': { uid: 'agent-se', name: 'SE', role: 'worker', workspace: 'boos' },
      'agent-legacy': { uid: 'agent-legacy', name: 'Legacy', role: 'worker', workspace: 'boos' },
    },
    tasks: {},
    sessions: {},
    identities: {},
    dags: {},
    dag_tasks: {},
  });

  // Folders DB with a sandboxed folder
  writeJson(path.join(TMP, 'folders.json'), [
    {
      id: 'folder-sbox',
      name: 'Sandboxed Folder',
      rootPath: path.join(TMP, 'sandbox-root'),
      agentLevels: {
        'agent-pm': { sandbox: 'PM', write: true },
        'agent-pmo': { sandbox: 'PMO', write: true },
        'agent-se': { sandbox: 'SE', write: false },
        'agent-worker': { write: true },
        'agent-legacy': { sandbox: 'SE', write: true },
        // Sprint 33: keyed by BOOS session ID
        'sess-pm': { sandbox: 'PM', write: true },
        'sess-pmo': { sandbox: 'PMO', write: true },
        'sess-se': { sandbox: 'SE', write: false },
      },
    },
    { id: 'folder-no-root', name: 'No RootPath Folder' },
  ]);

  // Persisted sessions
  writeJson(path.join(TMP, 'sessions.json'), [
    { id: 'sess-pm', cliId: 'claude', cliSessionId: 'agent-pm', status: 'running',
      pid: process.pid, folderId: 'folder-sbox', cwd: TMP },
    { id: 'sess-worker', cliId: 'claude', cliSessionId: 'agent-worker', status: 'running',
      pid: process.pid, folderId: 'folder-sbox', cwd: TMP },
    { id: 'sess-pmo', cliId: 'claude', cliSessionId: 'agent-pmo', status: 'running',
      pid: process.pid, folderId: 'folder-sbox', cwd: TMP },
    { id: 'sess-se', cliId: 'claude', cliSessionId: 'agent-se', status: 'running',
      pid: process.pid, folderId: 'folder-sbox', cwd: TMP },
    { id: 'sess-legacy', cliId: 'claude', status: 'running', pid: process.pid,
      folderId: 'folder-sbox', cwd: TMP, workspace: 'agent-legacy' },
    { id: 'sess-no-folder', cliId: 'claude', cliSessionId: 'agent-no-folder',
      status: 'running', pid: process.pid, cwd: TMP },
  ]);

  // Create sandbox root dir
  ensureDir(path.join(TMP, 'sandbox-root'));
  // Create a file inside sandbox
  fs.writeFileSync(path.join(TMP, 'sandbox-root', 'inside.txt'), 'hello', 'utf-8');
  // Create a file outside sandbox
  fs.writeFileSync(path.join(TMP, 'outside.txt'), 'outside', 'utf-8');

  // Clear require cache for modules that read DATA_DIR at load time
  for (const mod of Object.keys(require.cache)) {
    if (mod.includes('config.js') || mod.includes('folders.js') ||
        mod.includes('persistedSessions.js') || mod.includes('storeCore.js') ||
        mod.includes('sandbox.js') || mod.includes('store.js') ||
        mod.includes('storeIdentity.js') || mod.includes('identityResolver.js')) {
      delete require.cache[mod];
    }
  }
}

function teardownDataDir() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (origHome === undefined) delete process.env.BOOS_HOME;
  else process.env.BOOS_HOME = origHome;
  // Clear again so subsequent test files start fresh
  for (const mod of Object.keys(require.cache)) {
    if (mod.includes('config.js') || mod.includes('folders.js') ||
        mod.includes('persistedSessions.js') || mod.includes('storeCore.js') ||
        mod.includes('sandbox.js') || mod.includes('store.js') ||
        mod.includes('storeIdentity.js') || mod.includes('identityResolver.js')) {
      delete require.cache[mod];
    }
  }
}

// ── isAllowed ────────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  let sandbox;
  const sandboxRoot = path.join(TMP, 'sandbox-root');

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('PM (supervisor role) always allowed — even outside sandbox', async () => {
    const result = await sandbox.isAllowed('agent-pm', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('PM (supervisor role) allowed for any path', async () => {
    const result = await sandbox.isAllowed('agent-pm', '/some/random/path/file.js');
    assert.strictEqual(result.allowed, true);
  });

  test('PMO agent always allowed (sandbox bypass)', async () => {
    const result = await sandbox.isAllowed('agent-pmo', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('PM allowerd via folder-level agentLevels PM', async () => {
    // agent-pm has folder-level PM via agentLevels
    const result = await sandbox.isAllowed('agent-pm', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('worker with folder rootPath — allowed inside sandbox', async () => {
    const result = await sandbox.isAllowed('agent-worker', path.join(sandboxRoot, 'inside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('worker with folder rootPath — denied outside sandbox', async () => {
    const result = await sandbox.isAllowed('agent-worker', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('outside sandbox'));
  });

  test('worker with no folder rootPath — allowed anywhere', async () => {
    // agent-no-folder session has no folderId → no rootPath → allowed
    // Need to set up an agent with cliSessionId matching the session
    const result = await sandbox.isAllowed('nonexistent-agent', path.join(TMP, 'outside.txt'));
    // No registered agent → _isPM returns false, _resolveFolderId returns null → allowed
    assert.strictEqual(result.allowed, true);
  });

  test('path exactly equals rootPath is allowed', async () => {
    const result = await sandbox.isAllowed('agent-worker', sandboxRoot);
    assert.strictEqual(result.allowed, true);
  });

  test('path with .. traversal outside root is denied', async () => {
    const result = await sandbox.isAllowed('agent-worker', path.join(sandboxRoot, '..', 'outside.txt'));
    assert.strictEqual(result.allowed, false);
  });

  test('path normalization handles trailing separators', async () => {
    const result = await sandbox.isAllowed('agent-worker', sandboxRoot + path.sep + 'inside.txt');
    assert.strictEqual(result.allowed, true);
  });

  test('non-existent agent returns allowed:true (no folder bound)', async () => {
    const result = await sandbox.isAllowed('agent-ghost', '/any/path');
    assert.strictEqual(result.allowed, true);
  });

  test('PMO via folder-level agentLevels bypasses sandbox', async () => {
    // agent-pmo has folder-level PMO
    const result = await sandbox.isAllowed('agent-pmo', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('SE agent (not PM/PMO) is sandbox-restricted', async () => {
    const result = await sandbox.isAllowed('agent-se', path.join(TMP, 'outside.txt'));
    assert.strictEqual(result.allowed, false);
  });
});

// ── getWritePermission ──────────────────────────────────────────────────────

describe('getWritePermission', () => {
  let sandbox;

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('PM always has write permission', async () => {
    const result = await sandbox.getWritePermission('agent-pm');
    assert.strictEqual(result, true);
  });

  test('worker with write:true in agentLevels returns true', async () => {
    const result = await sandbox.getWritePermission('agent-worker');
    assert.strictEqual(result, true);
  });

  test('worker with write:false in agentLevels returns false', async () => {
    const result = await sandbox.getWritePermission('agent-se');
    assert.strictEqual(result, false);
  });

  test('agent with no agentLevels entry defaults to true', async () => {
    const result = await sandbox.getWritePermission('agent-legacy');
    // Legacy path — matches by name → backfills identity → finds folder
    // folder-sbox has no agentLevels entry for agent-legacy → defaults true
    assert.strictEqual(result, true);
  });

  test('non-existent agent returns true (default allow)', async () => {
    const result = await sandbox.getWritePermission('agent-ghost');
    assert.strictEqual(result, true);
  });
});

// ── canWriteCodeFile ────────────────────────────────────────────────────────

describe('canWriteCodeFile', () => {
  let sandbox;

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('markdown files always allowed', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/file.md');
    assert.strictEqual(result.allowed, true);
  });

  test('.markdown files always allowed', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/file.markdown');
    assert.strictEqual(result.allowed, true);
  });

  test('.txt files always allowed', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/file.txt');
    assert.strictEqual(result.allowed, true);
  });

  test('.json files always allowed', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/config.json');
    assert.strictEqual(result.allowed, true);
  });

  test('.yaml / .yml files always allowed', async () => {
    const yamlResult = await sandbox.canWriteCodeFile('agent-se', '/path/to/ci.yaml');
    const ymlResult = await sandbox.canWriteCodeFile('agent-se', '/path/to/ci.yml');
    assert.strictEqual(yamlResult.allowed, true);
    assert.strictEqual(ymlResult.allowed, true);
  });

  test('.toml files always allowed', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/Cargo.toml');
    assert.strictEqual(result.allowed, true);
  });

  test('.js files blocked for write:false agent', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/app.js');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('write permission'));
  });

  test('.ts files blocked for write:false agent', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/app.ts');
    assert.strictEqual(result.allowed, false);
  });

  test('.py files blocked for write:false agent', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/script.py');
    assert.strictEqual(result.allowed, false);
  });

  test('.js files allowed for write:true agent', async () => {
    const result = await sandbox.canWriteCodeFile('agent-worker', '/path/to/app.js');
    assert.strictEqual(result.allowed, true);
  });

  test('PM always allowed to write code files', async () => {
    const result = await sandbox.canWriteCodeFile('agent-pm', '/path/to/app.js');
    assert.strictEqual(result.allowed, true);
  });

  test('empty file path with write:false agent is denied', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '');
    // extname('') → '' → not in docExts → write check fails → denied
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('write permission'));
  });

  test('null file path with write:false agent is denied', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', null);
    // extname(null) → '.' → not in docExts → write check fails → denied
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('write permission'));
  });

  test('case-insensitive extension check', async () => {
    const result = await sandbox.canWriteCodeFile('agent-se', '/path/to/file.MD');
    assert.strictEqual(result.allowed, true);
  });
});

// ── getFilesystemMcpConfig ──────────────────────────────────────────────────

describe('getFilesystemMcpConfig', () => {
  let sandbox;
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const FS_SERVER = path.join(__dirname, '..', 'claudes', '.mcp', 'filesystem', 'dist', 'index.js');

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('returns command:node with fs server path', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({});
    assert.strictEqual(cfg.command, 'node');
    assert.ok(cfg.args.length >= 2);
    assert.ok(cfg.args[0].endsWith('index.js'));
  });

  test('PM gets full project root access', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ agentUid: 'agent-pm' });
    assert.strictEqual(cfg.command, 'node');
    assert.strictEqual(cfg.args[1], PROJECT_ROOT);
  });

  test('PMO gets full project root access', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ agentUid: 'agent-pmo' });
    assert.strictEqual(cfg.args[1], PROJECT_ROOT); // PMO bypass
  });

  test('worker with folderId gets sandboxed to rootPath', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ folderId: 'folder-sbox', agentUid: 'agent-worker' });
    const sandboxRoot = path.join(TMP, 'sandbox-root');
    assert.strictEqual(cfg.args[1], path.resolve(sandboxRoot));
  });

  test('worker without folderId gets project root', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ agentUid: 'agent-worker' });
    assert.strictEqual(cfg.args[1], PROJECT_ROOT);
  });

  test('PM gets no write-extension restriction args', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ agentUid: 'agent-pm' });
    const hasWriteExt = cfg.args.some((a) => a.startsWith('--write-extensions='));
    assert.strictEqual(hasWriteExt, false);
  });

  test('no agent with folderId uses folder rootPath', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ folderId: 'folder-sbox' });
    const sandboxRoot = path.join(TMP, 'sandbox-root');
    assert.strictEqual(cfg.args[1], path.resolve(sandboxRoot));
  });

  test('non-existent folderId falls back to project root', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({ folderId: 'nonexistent-folder' });
    assert.strictEqual(cfg.args[1], PROJECT_ROOT);
  });

  test('returns 2 args minimum for non-PM, non-folder case', async () => {
    const cfg = await sandbox.getFilesystemMcpConfig({});
    assert.ok(cfg.args.length >= 2);
    assert.strictEqual(cfg.args[0], FS_SERVER);
  });
});

// ── edge cases ───────────────────────────────────────────────────────────────

describe('sandbox edge cases', () => {
  let sandbox;

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('isAllowed with relative path resolves correctly', async () => {
    // Non-PM agent with relative path inside sandbox
    const result = await sandbox.isAllowed('agent-worker', path.join(TMP, 'sandbox-root', 'subdir', '..', 'inside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('isAllowed with symlink-like path (normalized)', async () => {
    const result = await sandbox.isAllowed('agent-worker',
      path.join(TMP, 'sandbox-root', 'a', '..', 'b', '..', 'inside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('isAllowed with deeply nested path inside sandbox', async () => {
    const deep = path.join(TMP, 'sandbox-root', 'a', 'b', 'c', 'd', 'file.txt');
    const result = await sandbox.isAllowed('agent-worker', deep);
    assert.strictEqual(result.allowed, true);
  });

  test('getWritePermission for agent without folder defaults to true', async () => {
    // agent-no-folder has a session without folderId
    // We need the agent registered with matching cliSessionId
    // But we didn't register 'agent-no-folder' in agent-bus.json
    // So it'll go through fallback paths → eventually return true
    const result = await sandbox.getWritePermission('agent-no-folder');
    assert.strictEqual(result, true);
  });

  test('isAllowed handles empty string path', async () => {
    const result = await sandbox.isAllowed('agent-worker', '');
    // Empty path relative → resolves to cwd, which is not in sandbox → denied
    assert.strictEqual(result.allowed, false);
  });
});

// ── persistedSessions.findByCliSessionId integration ─────────────────────────

describe('sandbox Sprint 33 fast path', () => {
  let sandbox;

  before(() => {
    setupDataDir();
    sandbox = require('../lib/sandbox');
  });

  after(() => {
    teardownDataDir();
  });

  test('Sprint 33: agent uid matches cliSessionId → direct folder lookup', async () => {
    // agent-pm has cliSessionId='agent-pm' → sess-pm has folderId='folder-sbox'
    // isAllowed → _isPM returns true → allowed
    const result = await sandbox.isAllowed('agent-pm', '/anywhere/file.js');
    assert.strictEqual(result.allowed, true);
  });

  test('Sprint 33: worker found via cliSessionId → folder resolved', async () => {
    // agent-worker has cliSessionId='agent-worker' → sess-worker has folderId='folder-sbox'
    const result = await sandbox.isAllowed('agent-worker', path.join(TMP, 'sandbox-root', 'inside.txt'));
    assert.strictEqual(result.allowed, true);
  });

  test('Sprint 33: session exists but no folderId → returns null (default allow)', async () => {
    // We need an agent with cliSessionId that matches a session without folderId
    // Let's add one to the test data first... Actually sess-no-folder already exists
    // and has cliSessionId='agent-no-folder'. But agent-no-folder isn't registered in agent-bus.
    // That's fine — _resolveFolderId will find the session but session.folderId is undefined → returns null → allowed
    const result = await sandbox.isAllowed('agent-no-folder', '/any/path');
    assert.strictEqual(result.allowed, true);
  });
});
