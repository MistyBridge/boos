// Conversation sync engine — Sprint 7.
//
// Incrementally syncs Claude JSONL conversation files into PostgreSQL.
// Uses byte-offset cursors in conversation_files.last_offset so we only
// read new data on each scan. Handles file truncation/rotation gracefully.
//
// Content extraction (for search):
//   type='user'      → message.content (string or text-block array)
//   type='assistant' → same
//   type='tool_use' | 'system' → null
//
// exports:
//   syncSession(pool, cliSessionId, jsonlPath, boosSessionId, cwd, projectSlug)
//     → { turnsSynced: number }
//   getLatestForCwd(pool, cwd) → { cliSessionId, turnCount } | null
//   syncAllRunning(pool, sessions) → { sessions, totalTurns }

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const readline = require('node:readline');

// ── content extraction ────────────────────────────────────────────────────

function _extractType(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown';
  // Claude JSONL format: { type: 'user'|'assistant', message: { content: ... } }
  if (obj.type === 'user') return 'user';
  if (obj.type === 'assistant') return 'assistant';
  // Tool use: { type: 'tool_use', ... } or { type: 'tool_result', ... }
  if (obj.type === 'tool_use' || obj.type === 'tool_result') return 'tool_use';
  // System / metadata lines — skip content extraction.
  if (obj.type === 'system') return 'system';
  // Heuristic: if it has a message field, treat as assistant.
  if (obj.message) return obj.type || 'assistant';
  return obj.type || 'unknown';
}

function _extractContent(obj) {
  if (!obj || !obj.message) return null;
  const content = obj.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // TextBlock: { type: 'text', text: '...' }
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return null;
}

// ── turn insertion ────────────────────────────────────────────────────────

async function _insertTurns(pool, cliSessionId, turns) {
  if (!turns.length) return 0;

  // Batch insert in chunks of 50 to avoid huge parameter lists.
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < turns.length; i += CHUNK) {
    const chunk = turns.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let idx = 1;
    for (const t of chunk) {
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
      params.push(cliSessionId, t.turn_index, t.turn_type, t.content_text, JSON.stringify(t.raw_json));
      idx += 5;
    }
    const sql = `
      INSERT INTO conversation_turns (cli_session_id, turn_index, turn_type, content_text, raw_json)
      VALUES ${values.join(', ')}
      ON CONFLICT (cli_session_id, turn_index) DO NOTHING
    `;
    try {
      const result = await pool.query(sql, params);
      inserted += result.rowCount || 0;
    } catch (e) {
      console.warn('[boos] conversationSync: batch insert failed —', e.message);
    }
  }
  return inserted;
}

// ── main sync function ────────────────────────────────────────────────────

async function syncSession(pool, cliSessionId, jsonlPath, boosSessionId, cwd, projectSlug) {
  if (!pool || !cliSessionId || !jsonlPath) return { turnsSynced: 0 };

  // 1. Stat the JSONL file.
  let stat;
  try {
    stat = await fsp.stat(jsonlPath);
  } catch {
    return { turnsSynced: 0, error: 'jsonl file not found' };
  }
  const fileSize = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);

  // 2. Query or insert the conversation_files row.
  let fileRow;
  try {
    const r = await pool.query('SELECT * FROM conversation_files WHERE cli_session_id = $1', [cliSessionId]);
    fileRow = r.rows[0] || null;
  } catch (e) {
    console.warn('[boos] conversationSync: file row query failed —', e.message);
    return { turnsSynced: 0, error: e.message };
  }

  let lastOffset = 0;

  if (!fileRow) {
    // First time seeing this session — insert the row.
    try {
      await pool.query(
        `INSERT INTO conversation_files (cli_session_id, boos_session_id, project_slug, cwd, jsonl_path, last_offset, last_mtime_ms)
         VALUES ($1, $2, $3, $4, $5, 0, $6)
         ON CONFLICT (cli_session_id) DO NOTHING`,
        [cliSessionId, boosSessionId, projectSlug || '', cwd || '', jsonlPath, mtimeMs],
      );
    } catch (e) {
      console.warn('[boos] conversationSync: file row insert failed —', e.message);
      return { turnsSynced: 0, error: e.message };
    }
    lastOffset = 0;
  } else {
    // Compare mtime — skip if unchanged.
    if (fileRow.last_mtime_ms && mtimeMs <= fileRow.last_mtime_ms) {
      return { turnsSynced: 0, skipped: true };
    }
    // Detect truncation / rotation: file is smaller than our last offset.
    if (fileSize < fileRow.last_offset) {
      lastOffset = 0;
    } else {
      lastOffset = fileRow.last_offset;
    }
  }

  // 3. Read new bytes and parse JSONL lines.
  if (fileSize <= lastOffset) {
    // Update mtime but don't re-read.
    try {
      await pool.query(
        'UPDATE conversation_files SET last_mtime_ms = $1, updated_at = NOW() WHERE cli_session_id = $2',
        [mtimeMs, cliSessionId],
      );
    } catch {}
    return { turnsSynced: 0 };
  }

  const turns = [];
  let turnIndex = lastOffset === 0 ? 0 : undefined; // will be set by line counter
  let lineIdx = 0;
  let parseErrors = 0;

  try {
    const stream = fs.createReadStream(jsonlPath, { start: Number(lastOffset), encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineIdx++;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }
      const turnType = _extractType(obj);
      if (turnType === 'system') continue; // skip metadata lines

      const contentText = _extractContent(obj);
      turns.push({
        turn_index: turnIndex != null ? turnIndex++ : lineIdx - 1,
        turn_type: turnType,
        content_text: contentText,
        raw_json: obj,
      });
    }
  } catch (e) {
    console.warn('[boos] conversationSync: stream read failed —', e.message);
    return { turnsSynced: 0, error: e.message };
  }

  // 4. Insert turns.
  let inserted = 0;
  if (turns.length > 0) {
    // If we reset offset (truncation), the turn_index should restart from 0.
    if (lastOffset === 0 || turnIndex === undefined) {
      // Re-derive: the first new line's turn_index is relative to what was already stored.
      // We need to know the existing max turn_index.
      try {
        const maxR = await pool.query(
          'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_idx FROM conversation_turns WHERE cli_session_id = $1',
          [cliSessionId],
        );
        const base = Number(maxR.rows[0]?.next_idx) || 0;
        for (let i = 0; i < turns.length; i++) {
          turns[i].turn_index = base + i;
        }
      } catch {
        // Fallback: index from 0 — ON CONFLICT will handle dupes.
      }
    }
    inserted = await _insertTurns(pool, cliSessionId, turns);
  }

  // 5. Update the cursor.
  try {
    const newCount = fileRow ? fileRow.turn_count + inserted : inserted;
    await pool.query(
      `UPDATE conversation_files
       SET last_offset = $1, last_mtime_ms = $2, turn_count = $3, boos_session_id = $4, cwd = $5, updated_at = NOW()
       WHERE cli_session_id = $6`,
      [fileSize, mtimeMs, newCount, boosSessionId, cwd || '', cliSessionId],
    );
  } catch (e) {
    console.warn('[boos] conversationSync: cursor update failed —', e.message);
  }

  return { turnsSynced: inserted, parseErrors };
}

// ── cwd lookup ────────────────────────────────────────────────────────────

async function getLatestForCwd(pool, cwd) {
  if (!pool || !cwd) return null;
  try {
    const r = await pool.query(
      `SELECT cli_session_id, turn_count, updated_at
       FROM conversation_files
       WHERE cwd = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cwd],
    );
    if (!r.rows.length) return null;
    return {
      cliSessionId: r.rows[0].cli_session_id,
      turnCount: r.rows[0].turn_count,
      updatedAt: r.rows[0].updated_at,
    };
  } catch (e) {
    console.warn('[boos] conversationSync: getLatestForCwd failed —', e.message);
    return null;
  }
}

// ── batch sync ────────────────────────────────────────────────────────────

async function syncAllRunning(pool, sessions) {
  if (!pool || !sessions || !sessions.length) return { sessions: 0, totalTurns: 0 };

  let totalTurns = 0;
  let synced = 0;

  for (const s of sessions) {
    if (!s.cliSessionId || !s.projectSlug) continue;
    const jsonlPath = _jsonlPath(s);
    if (!jsonlPath) continue;

    try {
      const result = await syncSession(
        pool,
        s.cliSessionId,
        jsonlPath,
        s.id,
        s.cwd,
        s.projectSlug,
      );
      if (result.turnsSynced > 0) {
        synced++;
        totalTurns += result.turnsSynced;
      }
    } catch {}
  }

  return { sessions: synced, totalTurns };
}

function _jsonlPath(session) {
  if (!session.projectSlug || !session.cliSessionId) return null;
  const projectsDir = require('node:path').join(require('node:os').homedir(), '.claude', 'projects');
  return require('node:path').join(projectsDir, session.projectSlug, `${session.cliSessionId}.jsonl`);
}

module.exports = {
  syncSession,
  getLatestForCwd,
  syncAllRunning,
};
