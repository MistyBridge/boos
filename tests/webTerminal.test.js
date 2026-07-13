'use strict';

// Mock node-pty before requiring webTerminal.js.
// node-pty is a native module — we inject a fake via require.cache.
const EventEmitter = require('node:events');

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 90000) + 10000;
    this._killed = false;
    this._written = '';
  }
  write(data) {
    this._written += data;
    // Emit synchronously so tests can assert immediately
    this.emit('data', data);
  }
  kill() {
    this._killed = true;
    // Emit synchronously so onExit handler runs before test assertions
    this.emit('exit', { exitCode: 0, signal: null });
  }
  resize() {}
  onData(fn) { this.on('data', fn); }
  onExit(fn) { this.on('exit', fn); }
}

// Inject fake node-pty into require cache BEFORE webTerminal loads it
const fakePtyModule = {
  spawn(command, args, opts) {
    return new FakePty();
  },
};

// Cache the fake module at the node-pty resolve path
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = {
  id: ptyPath,
  filename: ptyPath,
  loaded: true,
  exports: fakePtyModule,
};

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Now require webTerminal — it will get our fake node-pty
const webTerminal = require('../lib/webTerminal');

// Helper: create a mock WebSocket
function mockWs() {
  const handlers = {};
  const ws = {
    sent: [],
    closed: null,
    on(event, fn) { handlers[event] = fn; },
    send(data) { ws.sent.push(data); },
    close(code, reason) { ws.closed = { code, reason }; },
    _trigger(event, ...args) { if (handlers[event]) handlers[event](...args); },
  };
  return ws;
}

afterEach(() => {
  // Kill all PTYs after each test
  webTerminal.killAll();
});

describe('webTerminal · spawn', () => {
  test('spawn() creates a PTY and returns entry', () => {
    assert.ok(webTerminal.available);

    const entry = webTerminal.spawn({
      command: 'cmd.exe',
      args: ['/c', 'echo hello'],
      cwd: process.cwd(),
    });

    assert.ok(entry.id.startsWith('web-'));
    assert.equal(entry.meta.command, 'cmd.exe');
    assert.ok(entry.meta.pid > 0);
    assert.equal(entry.exitCode, null);
    assert.equal(entry.exitedAt, null);
    assert.equal(entry.sockets.size, 0);
    assert.ok(typeof entry.history === 'string');
  });

  test('spawn() accepts custom id', () => {
    const entry = webTerminal.spawn({
      command: 'test',
      id: 'sess-custom-123',
    });
    assert.equal(entry.id, 'sess-custom-123');
  });

  test('spawn() records output in history', () => {
    const entry = webTerminal.spawn({
      command: 'test',
    });
    entry.pty.write('hello world\n');
    assert.ok(entry.history.includes('hello world'));
  });
});

describe('webTerminal · attach + detach', () => {
  test('attach() wires a websocket and replays history', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    entry.pty.write('preexisting output\n');

    const ws = mockWs();
    webTerminal.attach(entry.id, ws);

    assert.equal(entry.sockets.size, 1);
    // Should have replayed history
    const replay = ws.sent.find((s) => {
      try { return JSON.parse(s).replay; } catch { return false; }
    });
    assert.ok(replay, 'should replay history');
  });

  test('attach() closes previous client (latest-wins)', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    const ws1 = mockWs();
    webTerminal.attach(entry.id, ws1);

    const ws2 = mockWs();
    webTerminal.attach(entry.id, ws2);

    // ws1 should be displaced
    assert.ok(ws1.closed, 'old client should be closed');
    assert.equal(ws1.closed.code, 4001);
    assert.equal(entry.sockets.size, 1);
  });

  test('input messages are forwarded to PTY', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    const ws = mockWs();
    webTerminal.attach(entry.id, ws);

    ws._trigger('message', JSON.stringify({ type: 'input', data: 'ls -la\n' }));
    assert.ok(entry.pty._written.includes('ls -la'));
  });

  test('resize messages are forwarded', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    const ws = mockWs();
    webTerminal.attach(entry.id, ws);

    // Should not throw
    ws._trigger('message', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });

  test('exit message is sent on PTY exit', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    const ws = mockWs();
    webTerminal.attach(entry.id, ws);

    entry.pty.kill();

    // Should have sent exit frame
    const exitMsg = ws.sent.find((s) => {
      try { return JSON.parse(s).type === 'exit'; } catch { return false; }
    });
    assert.ok(exitMsg);
  });
});

describe('webTerminal · lifecycle', () => {
  test('kill() ends a running PTY', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    assert.equal(entry.exitedAt, null);

    const result = webTerminal.kill(entry.id);
    assert.equal(result, true);
    assert.ok(entry.exitedAt > 0);
    assert.equal(entry.exitCode, 0);
  });

  test('kill() returns false for nonexistent', () => {
    assert.equal(webTerminal.kill('no-such-id'), false);
  });

  test('kill() is no-op on already-exited PTY', () => {
    const entry = webTerminal.spawn({ command: 'test' });
    webTerminal.kill(entry.id);
    assert.equal(webTerminal.kill(entry.id), false);
  });

  test('list() returns all sessions', () => {
    const e1 = webTerminal.spawn({ command: 'cmd1', id: 'sess-a' });
    const e2 = webTerminal.spawn({ command: 'cmd2', id: 'sess-b' });

    const list = webTerminal.list();
    assert.ok(list.length >= 2);
    assert.ok(list.find((e) => e.id === 'sess-a'));
    assert.ok(list.find((e) => e.id === 'sess-b'));
  });

  test('get() returns session metadata', () => {
    webTerminal.spawn({ command: 'test', id: 'sess-get' });
    const info = webTerminal.get('sess-get');
    assert.equal(info.id, 'sess-get');
    assert.equal(info.attached, 0);
    assert.equal(info.exitedAt, null);

    assert.equal(webTerminal.get('ghost'), null);
  });
});

describe('webTerminal · gracefulKillAll', () => {
  test('gracefulKillAll() resolves and kills all PTYs', async () => {
    // Spawn sessions without killing them first
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = `graceful-${i}-${Date.now()}`;
      ids.push(id);
      webTerminal.spawn({ command: 'test', id });
    }

    // gracefulKillAll sends Ctrl+C and waits
    await webTerminal.gracefulKillAll(200);

    // All sessions should now be exited
    const list = webTerminal.list();
    const ours = list.filter((e) => ids.includes(e.id));
    for (const e of ours) {
      assert.ok(e.exitedAt > 0 || e.exitCode !== null, `${e.id} should be exited`);
    }
  });

  test('gracefulKillAll() handles empty pool', async () => {
    // Kill all first
    webTerminal.killAll();
    // Should resolve immediately
    await webTerminal.gracefulKillAll(100);
  });
});
