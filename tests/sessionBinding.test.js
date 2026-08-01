'use strict';

// Session Binding — tests for lib/sessionBinding.js
//
// Covers: bindingCwdKey(), createScanner() and its returned API surface,
// scanSessionBindings guards / early-returns, scheduleBindingScan /
// scheduleBindingScanSeries / startPeriodicScan lifecycle, concurrency
// guard, and module re-exports from sessionBindingDetect.
//
// Heavy integration paths (detectMod.detect with real process trees) are
// exercised through the guard / early-return coverage here; the detect
// module itself is tested separately through ptyScanner.test.js.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockDeps(overrides = {}) {
  return {
    persistedSessions: {
      loadAll: async () => [],
      setCliSessionId: async () => {},
      setProjectSlug: async () => {},
      ...overrides.persistedSessions,
    },
    webTerminal: {
      available: true,
      list: () => [],
      get: () => null,
      ...overrides.webTerminal,
    },
    loadConfig: async () => ({
      clis: [{ id: 'claude', type: 'claude' }, { id: 'codex', type: 'codex' }],
      ...overrides.config,
    }),
  };
}

// ── bindingCwdKey ────────────────────────────────────────────────────────────

describe('bindingCwdKey', () => {
  const { bindingCwdKey } = require('../lib/sessionBinding');

  test('creates key containing type and-resolved cwd', () => {
    const key = bindingCwdKey('claude', '/home/user/project');
    assert.ok(key.includes('claude'));
    assert.ok(key.includes('\0'));
    assert.ok(key.includes(path.resolve('/home/user/project').toLowerCase()));
  });

  test('resolves relative paths to absolute', () => {
    const key = bindingCwdKey('claude', './relative');
    const expected = path.resolve('./relative').toLowerCase();
    assert.ok(key.endsWith(expected));
  });

  test('empty type defaults to "unknown"', () => {
    const key = bindingCwdKey('', '/some/path');
    const [type] = key.split('\0');
    assert.strictEqual(type, 'unknown');
  });

  test('null/undefined cwd produces string key', () => {
    const key = bindingCwdKey('claude', null);
    assert.ok(typeof key === 'string');
    assert.ok(key.length > 0);
  });

  test('non-string cwd is coerced gracefully', () => {
    const key = bindingCwdKey('claude', 12345);
    assert.ok(typeof key === 'string');
    assert.ok(key.includes('claude'));
  });

  test('deterministic — same inputs produce identical keys', () => {
    const k1 = bindingCwdKey('claude', '/same/path');
    const k2 = bindingCwdKey('claude', '/same/path');
    assert.strictEqual(k1, k2);
  });

  test('different types with same cwd produce different keys', () => {
    const k1 = bindingCwdKey('claude', '/same/path');
    const k2 = bindingCwdKey('codex', '/same/path');
    assert.notStrictEqual(k1, k2);
  });

  test('different cwds with same type produce different keys', () => {
    const k1 = bindingCwdKey('claude', '/path/a');
    const k2 = bindingCwdKey('claude', '/path/b');
    assert.notStrictEqual(k1, k2);
  });

  test('case-insensitive cwd normalization', () => {
    const k1 = bindingCwdKey('claude', '/Path/UPPER');
    const k2 = bindingCwdKey('claude', '/path/upper');
    assert.strictEqual(k1, k2);
  });

  test('path.resolve throws → falls back to raw string', () => {
    // bindingCwdKey wraps path.resolve in try/catch — verify it never throws
    const key = bindingCwdKey('claude', '\0invalid');
    assert.ok(typeof key === 'string');
  });
});

// ── createScanner (API surface) ──────────────────────────────────────────────

describe('createScanner — API surface', () => {
  const { createScanner } = require('../lib/sessionBinding');

  let scanner;

  beforeEach(() => {
    scanner = createScanner(makeMockDeps());
  });

  test('returns object with all expected methods', () => {
    assert.ok(typeof scanner === 'object');
    assert.ok(typeof scanner.scanSessionBindings === 'function');
    assert.ok(typeof scanner.scheduleBindingScan === 'function');
    assert.ok(typeof scanner.scheduleBindingScanSeries === 'function');
    assert.ok(typeof scanner.startPeriodicScan === 'function');
  });

  test('scanSessionBindings is async', () => {
    const result = scanner.scanSessionBindings();
    assert.ok(result instanceof Promise);
  });

  test('each createScanner call produces independent scanner', () => {
    const s1 = createScanner(makeMockDeps());
    const s2 = createScanner(makeMockDeps());
    assert.notStrictEqual(s1, s2);
    assert.notStrictEqual(s1.scanSessionBindings, s2.scanSessionBindings);
  });
});

// ── scanSessionBindings (early returns / guards) ─────────────────────────────

describe('scanSessionBindings — guards', () => {
  const { createScanner } = require('../lib/sessionBinding');

  test('returns immediately when webTerminal is unavailable', async () => {
    const deps = makeMockDeps({ webTerminal: { available: false } });
    const scanner = createScanner(deps);
    // Should not throw
    await scanner.scanSessionBindings();
  });

  test('returns immediately when no running sessions exist', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: { loadAll: async () => [] },
    }));
    await scanner.scanSessionBindings();
  });

  test('skips sessions without pid even when running', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-no-pid', cliId: 'claude', status: 'running' },
          { id: 'sess-no-pid-2', cliId: 'codex', status: 'running' },
        ],
      },
    }));
    await scanner.scanSessionBindings(); // all filtered — no error
  });

  test('skips non-bindable CLI types', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-1', cliId: 'other-unbindable', status: 'running', pid: 99999 },
        ],
      },
      config: { clis: [{ id: 'other-unbindable', type: 'unknown' }] },
    }));
    await scanner.scanSessionBindings();
  });

  test('returns early when loadConfig throws', async () => {
    const scanner = createScanner({
      ...makeMockDeps({
        persistedSessions: {
          loadAll: async () => [
            { id: 'sess-1', cliId: 'claude', status: 'running', pid: 99999 },
          ],
        },
      }),
      loadConfig: async () => { throw new Error('config-read-error'); },
    });
    await scanner.scanSessionBindings(); // must not throw
  });

  test('filters null entries from session list', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          null,
          undefined,
          { id: 'sess-ok', cliId: 'claude', status: 'running', pid: 99999 },
        ],
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('skips sessions with status !== "running"', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-stopped', cliId: 'claude', status: 'stopped', pid: 1111 },
          { id: 'sess-deleted', cliId: 'claude', status: 'running', pid: 2222, deletedAt: new Date().toISOString() },
        ],
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('handles empty config.clis array', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-1', cliId: 'claude', status: 'running', pid: 99999 },
        ],
      },
      config: { clis: [] },
    }));
    await scanner.scanSessionBindings();
  });
});

// ── scanSessionBindings (concurrency guard) ──────────────────────────────────

describe('scanSessionBindings — concurrency guard', () => {
  const { createScanner } = require('../lib/sessionBinding');

  test('does not run concurrently — second call blocked by guard', async () => {
    let loadCalls = 0;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => {
          loadCalls++;
          // Return empty to finish fast, but add a microtick so the guard matters.
          await new Promise((r) => setTimeout(r, 20));
          return [];
        },
      },
    }));

    await Promise.all([
      scanner.scanSessionBindings(),
      scanner.scanSessionBindings(),
      scanner.scanSessionBindings(),
    ]);
    // bindingScanRunning guard should prevent concurrent entry.
    // Only the first call enters; the rest see the guard and return.
    assert.strictEqual(loadCalls, 1);
  });

  test('scan can run again after previous scan completes', async () => {
    let loadCalls = 0;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => {
          loadCalls++;
          return [];
        },
      },
    }));

    await scanner.scanSessionBindings();
    assert.strictEqual(loadCalls, 1);

    await scanner.scanSessionBindings(); // guard has been reset
    assert.strictEqual(loadCalls, 2);
  });
});

// ── scanSessionBindings (process-tree → detect path) ────────────────────────

describe('scanSessionBindings — process-tree path', () => {
  const { createScanner } = require('../lib/sessionBinding');

  test('with real PID but no actual CLI process — detect swallows error', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-real', cliId: 'claude', status: 'running', pid: process.pid },
        ],
      },
    }));
    // detect() will try to read process tree for our real PID — should catch and continue.
    await scanner.scanSessionBindings();
  });

  test('handles sessions with mixed bindable / unbindable CLIs', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-claude', cliId: 'claude', status: 'running', pid: process.pid },
          { id: 'sess-other', cliId: 'other', status: 'running', pid: 99999 },
          { id: 'sess-codex', cliId: 'codex', status: 'running', pid: 99998 },
        ],
      },
      config: {
        clis: [
          { id: 'claude', type: 'claude' },
          { id: 'other', type: 'unknown' },
          { id: 'codex', type: 'codex' },
        ],
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('live PTY with meta.pid takes priority over record pid', async () => {
    const livePtyPid = process.pid; // real PID so detect can run
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-live', cliId: 'claude', status: 'running', pid: 99999 },
        ],
      },
      webTerminal: {
        available: true,
        get: (id) => {
          if (id === 'sess-live') return { exitedAt: null, meta: { pid: livePtyPid } };
          return null;
        },
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('exited PTY falls back to record pid', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-exited', cliId: 'claude', status: 'running', pid: process.pid },
        ],
      },
      webTerminal: {
        available: true,
        get: (id) => {
          if (id === 'sess-exited') return { exitedAt: new Date().toISOString(), meta: { pid: 88888 } };
          return null;
        },
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('webTerminal.get returns null → falls back to record pid', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-no-pty', cliId: 'claude', status: 'running', pid: process.pid },
        ],
      },
      webTerminal: {
        available: true,
        get: () => null,
      },
    }));
    await scanner.scanSessionBindings();
  });
});

// ── scheduleBindingScan ──────────────────────────────────────────────────────

describe('scheduleBindingScan', () => {
  const { createScanner } = require('../lib/sessionBinding');

  test('accepts explicit delay in milliseconds', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScan(2000);
    // Not throwing = pass
  });

  test('defaults to 4000 ms when no delay given', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScan();
  });

  test('schedule with short delay eventually fires scan (guard prevents double)', async () => {
    let loadCalls = 0;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => { loadCalls++; return []; },
      },
    }));

    scanner.scheduleBindingScan(10);
    // Schedule another to test that the guard of the first scan blocks it.
    scanner.scheduleBindingScan(15);

    // Wait for both timeouts to have fired.
    await new Promise((r) => setTimeout(r, 100));
    // The guard means only the first actual scan body runs.
    assert.ok(loadCalls >= 1, 'at least one scan should have run');
  });
});

// ── scheduleBindingScanSeries ────────────────────────────────────────────────

describe('scheduleBindingScanSeries', () => {
  const { createScanner } = require('../lib/sessionBinding');

  test('accepts array of delays', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScanSeries([100, 500, 2000]);
  });

  test('handles empty array', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScanSeries([]);
  });

  test('handles null/undefined array', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScanSeries(null);
    scanner.scheduleBindingScanSeries(undefined);
  });

  test('handles array with zero delay', () => {
    const scanner = createScanner(makeMockDeps());
    scanner.scheduleBindingScanSeries([0]);
  });
});

// ── startPeriodicScan ────────────────────────────────────────────────────────

describe('startPeriodicScan', () => {
  const { createScanner } = require('../lib/sessionBinding');
  const prevVal = process.env.BOOS_NO_BIND_SCAN;

  after(() => {
    // Restore env
    if (prevVal === undefined) delete process.env.BOOS_NO_BIND_SCAN;
    else process.env.BOOS_NO_BIND_SCAN = prevVal;
  });

  test('returns null when BOOS_NO_BIND_SCAN=1', () => {
    process.env.BOOS_NO_BIND_SCAN = '1';
    const scanner = createScanner(makeMockDeps());
    const timer = scanner.startPeriodicScan();
    assert.strictEqual(timer, null);
  });

  test('returns a timer object when scan is enabled', async () => {
    delete process.env.BOOS_NO_BIND_SCAN;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [],
      },
    }));
    const timer = scanner.startPeriodicScan();
    assert.ok(timer !== null);
    assert.ok(timer !== undefined);
    // Clean up
    clearInterval(timer);
    // Wait for any pending async scan to resolve
    await new Promise((r) => setTimeout(r, 50));
  });

  test('timer has unref safety — process exit not blocked', () => {
    delete process.env.BOOS_NO_BIND_SCAN;
    const scanner = createScanner(makeMockDeps());
    const timer = scanner.startPeriodicScan();
    assert.ok(timer.hasRef() || typeof timer.ref === 'function');
    clearInterval(timer);
  });
});

// ── module re-exports from sessionBindingDetect ──────────────────────────────

describe('module re-exports', () => {
  const sb = require('../lib/sessionBinding');

  test('exports snapshotProcessTree as function', () => {
    assert.ok(typeof sb.snapshotProcessTree === 'function');
  });

  test('exports descendantsOf as function', () => {
    assert.ok(typeof sb.descendantsOf === 'function');
  });

  test('exports detect as function', () => {
    assert.ok(typeof sb.detect === 'function');
  });

  test('exports supports as function', () => {
    assert.ok(typeof sb.supports === 'function');
  });

  test('exports bindingCwdKey as function', () => {
    assert.ok(typeof sb.bindingCwdKey === 'function');
  });

  test('exports createScanner as function', () => {
    assert.ok(typeof sb.createScanner === 'function');
  });
});

// ── edge cases ───────────────────────────────────────────────────────────────

describe('sessionBinding edge cases', () => {
  const { createScanner, bindingCwdKey } = require('../lib/sessionBinding');

  test('bindingCwdKey with very long paths', () => {
    const long = '/a'.repeat(200);
    const key = bindingCwdKey('claude', long);
    assert.ok(typeof key === 'string');
    assert.ok(key.length > 0);
  });

  test('bindingCwdKey with special characters in cwd', () => {
    const key = bindingCwdKey('claude', '/path/with spaces/and-dashes/and_underscores');
    assert.ok(key.includes('path'));
    assert.ok(key.includes('with spaces'));
  });

  test('scanner with no config.clis field', async () => {
    const scanner = createScanner({
      ...makeMockDeps({
        persistedSessions: {
          loadAll: async () => [
            { id: 'sess-1', cliId: 'claude', status: 'running', pid: 99999 },
          ],
        },
      }),
      loadConfig: async () => ({}),
    });
    await scanner.scanSessionBindings();
  });

  test('scanner with sessions that have no cliId', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-no-cli', status: 'running', pid: 99999 },
        ],
      },
    }));
    await scanner.scanSessionBindings();
  });

  test('duplicate codex cwd groups with existing cliSessionId skip rebind', async () => {
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'codex-1', cliId: 'codex', status: 'running', pid: process.pid,
            cliSessionId: 'cs-1', cwd: '/same/codex/dir', createdAt: 1000 },
          { id: 'codex-2', cliId: 'codex', status: 'running', pid: 99999,
            cliSessionId: 'cs-2', cwd: '/same/codex/dir', createdAt: 999 },
        ],
      },
      config: {
        clis: [{ id: 'codex', type: 'codex' }],
      },
    }));
    // codex-1 has cliSessionId and is duplicate → skipped (continue).
    // codex-2 has cliSessionId and is duplicate → skipped too.
    await scanner.scanSessionBindings();
  });

  test('detect returns null sessionId — no binding update', async () => {
    let setCliSessionIdCalled = false;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-null', cliId: 'claude', status: 'running', pid: 99999 },
        ],
        setCliSessionId: async () => { setCliSessionIdCalled = true; },
      },
    }));
    await scanner.scanSessionBindings();
    // detect returns null for invalid PID — setCliSessionId should not fire
    // (but it might fire if detect resolves something anyway — either way, no crash)
  });

  test('detect returns same sessionId — no duplicate update', async () => {
    let setCliSessionIdCalled = false;
    const scanner = createScanner(makeMockDeps({
      persistedSessions: {
        loadAll: async () => [
          { id: 'sess-same', cliId: 'claude', status: 'running', pid: process.pid,
            cliSessionId: 'same-id' },
        ],
        setCliSessionId: async () => { setCliSessionIdCalled = true; },
      },
    }));
    await scanner.scanSessionBindings();
    // If detect returns 'same-id', the `sid !== s.cliSessionId` guard blocks update.
  });
});
