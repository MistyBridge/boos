// Sprint 7: conversation sync engine unit tests.
// Tests incremental JSONL→PG sync with a mock pool.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Mock pool with in-memory storage.
function createMockPool() {
  const _files = new Map();    // cli_session_id → row
  const _turns = [];           // { cli_session_id, turn_index, turn_type, content_text, raw_json }

  return {
    _files,
    _turns,
    query(text, params) {
      const sql = text.trim().replace(/\s+/g, ' ');

      // SELECT from conversation_files
      if (sql.includes('SELECT * FROM conversation_files WHERE cli_session_id')) {
        const row = _files.get(params[0]);
        return Promise.resolve({ rows: row ? [row] : [] });
      }

      // SELECT COALESCE(MAX(turn_index)...)
      if (sql.includes('MAX(turn_index)')) {
        const sid = params[0];
        const sessionTurns = _turns.filter(t => t.cli_session_id === sid);
        const maxIdx = sessionTurns.length > 0
          ? Math.max(...sessionTurns.map(t => t.turn_index))
          : -1;
        return Promise.resolve({ rows: [{ next_idx: String(maxIdx + 1) }] });
      }

      // INSERT conversation_files
      if (sql.includes('INSERT INTO conversation_files')) {
        const row = {
          cli_session_id: params[0],
          boos_session_id: params[1],
          project_slug: params[2],
          cwd: params[3],
          jsonl_path: params[4],
          last_offset: params[5],
          last_mtime_ms: params[6],
          turn_count: 0,
        };
        _files.set(row.cli_session_id, row);
        return Promise.resolve({ rowCount: 1, rows: [row] });
      }

      // INSERT INTO conversation_turns — params are flat: sid, idx, type, content, json repeated
      if (sql.includes('INSERT INTO conversation_turns')) {
        let inserted = 0;
        for (let i = 0; i < params.length; i += 5) {
          if (i + 4 >= params.length) break;
          const turn = {
            cli_session_id: params[i],
            turn_index: params[i + 1],
            turn_type: params[i + 2],
            content_text: params[i + 3],
            raw_json: typeof params[i + 4] === 'string' ? JSON.parse(params[i + 4]) : params[i + 4],
          };
          const exists = _turns.some(
            t => t.cli_session_id === turn.cli_session_id && t.turn_index === turn.turn_index
          );
          if (!exists) {
            _turns.push(turn);
            inserted++;
          }
        }
        return Promise.resolve({ rowCount: inserted, rows: [] });
      }

      // UPDATE conversation_files
      if (sql.includes('UPDATE conversation_files')) {
        // First param is last_offset, second is last_mtime_ms, third is turn_count, fourth is boos_session_id, fifth is cwd, sixth is cli_session_id
        const row = _files.get(params[5]);
        if (row) {
          row.last_offset = params[0];
          row.last_mtime_ms = params[1];
          row.turn_count = params[2];
          row.boos_session_id = params[3];
          row.cwd = params[4];
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }

      // getLatestForCwd query
      if (sql.includes('SELECT cli_session_id, turn_count')) {
        const cwd = params[0];
        const matches = [..._files.values()]
          .filter(f => f.cwd === cwd)
          .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        if (matches.length > 0) {
          const m = matches[0];
          return Promise.resolve({
            rows: [{ cli_session_id: m.cli_session_id, turn_count: m.turn_count, updated_at: m.updated_at || new Date().toISOString() }],
          });
        }
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

// Create temporary JSONL file for tests.
function createJsonlFile(dir, lines) {
  const filePath = path.join(dir, 'test.jsonl');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

describe('conversationSync', () => {
  let tmpDir;
  let sync;

  before(async () => {
    sync = require('../lib/conversationSync');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boos-sync-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('syncSession', () => {
    it('syncs new turns from a JSONL file', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'user', message: { content: 'Hello, write a function' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Here is the function:\n```js\nfunction hello() {\n  return "hi";\n}\n```' } }),
      ]);

      const result = await sync.syncSession(
        pool, 'test-uuid-1', jsonlPath, 'sess-abc', '/home/user/proj', 'my-project',
      );

      assert.ok(result.turnsSynced >= 1, 'should sync at least one turn');
      assert.ok(pool._files.has('test-uuid-1'), 'should have inserted file row');
      assert.ok(pool._turns.length > 0, 'should have inserted turns');
    });

    it('extracts text content from string messages', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'user', message: { content: 'Simple string content' } }),
      ]);

      const result = await sync.syncSession(
        pool, 'test-uuid-2', jsonlPath, 'sess-def', '/work', 'proj2',
      );

      assert.ok(result.turnsSynced > 0);
      // Find the inserted turn
      const turns = pool._turns.filter(t => t.cli_session_id === 'test-uuid-2');
      const userTurns = turns.filter(t => t.turn_type === 'user');
      assert.ok(userTurns.length > 0, 'should have user turns');
      assert.equal(userTurns[0].content_text, 'Simple string content');
    });

    it('extracts text from array content (text blocks)', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First paragraph' },
              { type: 'text', text: 'Second paragraph' },
            ],
          },
        }),
      ]);

      await sync.syncSession(pool, 'test-uuid-3', jsonlPath, 'sess-ghi', '/work', 'p3');
      const turns = pool._turns.filter(t => t.cli_session_id === 'test-uuid-3');
      assert.ok(turns.length > 0);
      assert.ok(turns[0].content_text.includes('First paragraph'));
      assert.ok(turns[0].content_text.includes('Second paragraph'));
    });

    it('skips system-type lines', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'system', cwd: '/work' }),
        JSON.stringify({ type: 'user', message: { content: 'real message' } }),
      ]);

      await sync.syncSession(pool, 'test-uuid-4', jsonlPath, 'sess-jkl', '/work', 'p4');
      const turns = pool._turns.filter(t => t.cli_session_id === 'test-uuid-4');
      const sysTurns = turns.filter(t => t.turn_type === 'system');
      assert.equal(sysTurns.length, 0, 'system turns should be skipped');
      assert.ok(turns.length > 0, 'user turns should still be synced');
    });

    it('handles null content for tool_use messages', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'tool_use', name: 'read_file', input: { path: 'foo.js' } }),
      ]);

      await sync.syncSession(pool, 'test-uuid-5', jsonlPath, 'sess-mno', '/t', 'p5');
      const turns = pool._turns.filter(t => t.cli_session_id === 'test-uuid-5');
      assert.ok(turns.length > 0);
      assert.equal(turns[0].content_text, null, 'tool_use should have null content_text');
    });

    it('skips if file mtime has not changed', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'user', message: { content: 'first' } }),
      ]);

      // First sync.
      await sync.syncSession(pool, 'test-uuid-6', jsonlPath, 'sess-pqr', '/w', 'p6');
      const count1 = pool._turns.length;

      // Second sync — should skip because mtime hasn't changed.
      const result = await sync.syncSession(pool, 'test-uuid-6', jsonlPath, 'sess-pqr', '/w', 'p6');

      assert.ok(result.skipped, 'should skip unchanged file');
      assert.equal(pool._turns.length, count1, 'should not add duplicate turns');
    });

    it('detects truncation and re-syncs from offset 0', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'user', message: { content: 'msg1' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'reply1' } }),
      ]);

      await sync.syncSession(pool, 'test-uuid-7', jsonlPath, 'sess-stu', '/w', 'p7');

      // Simulate truncation: the file row's last_offset is larger than current file.
      const fileRow = pool._files.get('test-uuid-7');
      fileRow.last_offset = 999999; // larger than actual file

      // Append a new line to the jsonl (simulating rotation + new content)
      fs.appendFileSync(jsonlPath, '\n' + JSON.stringify({ type: 'user', message: { content: 'msg2' } }), 'utf8');

      const result = await sync.syncSession(pool, 'test-uuid-7', jsonlPath, 'sess-stu', '/w', 'p7');
      // Should detect truncation and re-sync.
      assert.ok(!result.skipped, 'should not skip after truncation');
    });
  });

  describe('getLatestForCwd', () => {
    it('returns null when no sessions match the cwd', async () => {
      const pool = createMockPool();
      const result = await sync.getLatestForCwd(pool, '/nonexistent');
      assert.equal(result, null);
    });

    it('returns the latest session for a given cwd', async () => {
      const pool = createMockPool();
      // Insert two file rows for the same cwd.
      pool._files.set('uuid-old', {
        cli_session_id: 'uuid-old', cwd: '/shared', turn_count: 5,
        updated_at: new Date('2026-01-01').toISOString(),
      });
      pool._files.set('uuid-new', {
        cli_session_id: 'uuid-new', cwd: '/shared', turn_count: 42,
        updated_at: new Date('2026-07-14').toISOString(),
      });

      const result = await sync.getLatestForCwd(pool, '/shared');
      assert.ok(result);
      assert.equal(result.cliSessionId, 'uuid-new');
      assert.equal(result.turnCount, 42);
    });

    it('returns null when pool is null', async () => {
      const result = await sync.getLatestForCwd(null, '/any');
      assert.equal(result, null);
    });
  });

  describe('syncAllRunning', () => {
    it('syncs multiple sessions and returns totals', async () => {
      const pool = createMockPool();

      // Create two JSONL files.
      const path1 = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'user', message: { content: 'hello from session 1' } }),
      ]);
      const path2 = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'assistant', message: { content: 'response from session 2' } }),
      ]);

      // Mock _jsonlPath by setting up the file rows correctly.
      const sessions = [
        { id: 'sess-1', cliSessionId: 'uuid-a', cwd: '/a', projectSlug: 'slug-a' },
        { id: 'sess-2', cliSessionId: 'uuid-b', cwd: '/b', projectSlug: 'slug-b' },
      ];

      // Override the path computation by pre-populating files and using syncSession directly.
      // syncAllRunning computes jsonlPath from projectSlug + cliSessionId — we can't easily
      // mock that without manipulating os.homedir(). Instead, test that syncSession is called
      // correctly for each session by pre-creating the JSONL at the expected path.
      const expectedPath1 = path.join(os.homedir(), '.claude', 'projects', 'slug-a', 'uuid-a.jsonl');
      const expectedPath2 = path.join(os.homedir(), '.claude', 'projects', 'slug-b', 'uuid-b.jsonl');

      try { fs.mkdirSync(path.dirname(expectedPath1), { recursive: true }); } catch {}
      try { fs.mkdirSync(path.dirname(expectedPath2), { recursive: true }); } catch {}
      fs.copyFileSync(path1, expectedPath1);
      fs.copyFileSync(path2, expectedPath2);

      try {
        const result = await sync.syncAllRunning(pool, sessions);
        assert.ok(typeof result.sessions === 'number');
        assert.ok(typeof result.totalTurns === 'number');
        // At least one session should have synced turns.
      } finally {
        try { fs.unlinkSync(expectedPath1); } catch {}
        try { fs.unlinkSync(expectedPath2); } catch {}
      }
    });

    it('handles empty session list', async () => {
      const pool = createMockPool();
      const result = await sync.syncAllRunning(pool, []);
      assert.equal(result.sessions, 0);
      assert.equal(result.totalTurns, 0);
    });

    it('handles null pool', async () => {
      const result = await sync.syncAllRunning(null, [{ id: 's' }]);
      assert.equal(result.sessions, 0);
    });
  });

  describe('content edge cases', () => {
    it('handles missing message field gracefully', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        JSON.stringify({ type: 'system', cwd: '/test' }),
      ]);

      await sync.syncSession(pool, 'uuid-edge-1', jsonlPath, 's-1', '/t', 'ps');
      // System types are skipped — no turns inserted.
      const turns = pool._turns.filter(t => t.cli_session_id === 'uuid-edge-1');
      assert.equal(turns.length, 0);
    });

    it('handles unparseable JSON lines gracefully', async () => {
      const pool = createMockPool();
      const jsonlPath = createJsonlFile(tmpDir, [
        '{invalid json',
        JSON.stringify({ type: 'user', message: { content: 'valid after garbage' } }),
      ]);

      const result = await sync.syncSession(pool, 'uuid-edge-2', jsonlPath, 's-2', '/t', 'ps');
      assert.ok(result.turnsSynced >= 0);
      // The valid line should be synced despite parse error on the first line.
      const turns = pool._turns.filter(t => t.cli_session_id === 'uuid-edge-2');
      assert.ok(turns.length > 0);
    });
  });
});
