// CacheStore — externalized content for agent-bus letters.
//
// Sprint 41: agent-bus letters must stay tiny. Long content (task bodies,
// submission results, feedback) is written to per-task cache FILES instead
// of being embedded in inbox JSON — otherwise every check_inbox / settle /
// notification round-trip re-echoes the full text into the model context.
//
// Layout: ~/.boos/agent-bus/cache/<task_id>-<kind>.md  (one small file each)
//   - content  → the original task body (externalized when > INLINE_MAX)
//   - result   → the worker's submission result
//   - feedback → PM settlement feedback
//
// Letters carry: content = short summary + ref marker; content_ref = 'cache:<kind>'
// Agents fetch full text on demand via get_task_content(task_id, kind).

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DATA_DIR } = require('../config');

const CACHE_DIR = path.join(DATA_DIR, 'agent-bus', 'cache');

// Letters inline up to this many chars; anything longer goes to a cache file.
const INLINE_MAX = 256;
const SUMMARY_MAX = 200;

function cachePath(taskId, kind) {
  // task ids contain only [a-z0-9_] — safe filename. Sanitize anyway.
  const safe = String(taskId || 'x').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe}-${kind}.md`);
}

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Write full content to the per-task cache file. Returns { ok, path }.
function write(taskId, kind, content) {
  if (!content || !String(content).trim()) return { ok: false, error: 'empty content' };
  try {
    ensureDir();
    const p = cachePath(taskId, kind);
    fs.writeFileSync(p, String(content), 'utf-8');
    return { ok: true, path: p, bytes: String(content).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Read full content back from the cache file. Returns string or null.
function read(taskId, kind) {
  try {
    const p = cachePath(taskId, kind);
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

// Read with fallback: if cache file missing, return the inline fallback.
function readOr(taskId, kind, fallback) {
  const full = read(taskId, kind);
  return full != null ? full : (fallback || null);
}

// Remove all cache files for a task (explicit cleanup).
function del(taskId) {
  if (!taskId) return;
  try {
    for (const kind of ['content', 'result', 'feedback']) {
      fs.unlinkSync(cachePath(taskId, kind));
    }
  } catch { /* best-effort */ }
}

// Sweep cache files older than maxAgeMs. Content is not deleted on task
// archive (PM may still read results via get_task_content), so old files
// accumulate — this bounds disk usage. Called on server start + daily.
function sweep(maxAgeMs = 7 * 24 * 3600 * 1000) {
  let removed = 0;
  try {
    ensureDir();
    const now = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.md')) continue;
      try {
        const st = fs.statSync(path.join(CACHE_DIR, f));
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(path.join(CACHE_DIR, f));
          removed++;
        }
      } catch { /* race — file already gone */ }
    }
  } catch { /* dir missing */ }
  return removed;
}

// ── letter shaping helpers ──────────────────────────────────────────────

// Externalize long content: returns { letter, ref } where letter is the
// inline text (summary + ref marker when externalized) and ref is
// 'cache:<kind>' or null. Task objects store letter in `content` and
// `content_ref` = ref.
function shapeContent(taskId, content, kind = 'content') {
  const text = String(content || '').trim();
  if (text.length <= INLINE_MAX) {
    return { letter: text, ref: null };
  }
  const w = write(taskId, kind, text);
  const summary = text.slice(0, SUMMARY_MAX) + (text.length > SUMMARY_MAX ? '…' : '');
  const letter = w.ok
    ? `${summary}\n[全文: cache/${path.basename(w.path)} — 用 get_task_content(${taskId}, "${kind}") 读取]`
    : text.slice(0, INLINE_MAX);
  return { letter, ref: w.ok ? `cache:${kind}` : null };
}

// Rehydrate a task's full content (used by get_task_content).
function fullContent(task, kind = 'content') {
  if (task && task.content_ref === `cache:${kind}`) {
    const full = read(task.task_id, kind);
    if (full != null) return full;
  }
  return task ? task.content : null;
}

module.exports = {
  CACHE_DIR, INLINE_MAX, SUMMARY_MAX,
  cachePath, write, read, readOr, del, sweep,
  shapeContent, fullContent,
};
