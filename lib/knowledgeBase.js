// Shared Knowledge Base — multi-level classified knowledge repository.
//
// Sprint 10 R12: agents maintain a shared knowledge folder at ~/.boos/knowledge/
// with mandatory updates after each task completion. This prevents colleagues
// from reading stale data and ensures institutional knowledge accumulates.
//
// Structure:
//   knowledge/
//   ├── architecture/    # Architecture decisions, design docs
//   ├── bugs/            # Known bugs + fix records
//   ├── patterns/        # Code patterns, best practices
//   ├── decisions/       # Decision summaries (aggregated)
//   ├── agents/          # Agent capabilities/status
//   └── INDEX.md         # Global index

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { DATA_DIR } = require('./config');

const KB_DIR = path.join(DATA_DIR, 'knowledge');

const VALID_SECTIONS = ['architecture', 'bugs', 'patterns', 'decisions', 'agents'];
const INDEX_FILE = 'INDEX.md';
const MAX_FILE_SIZE = 512 * 1024; // 512KB per file

// ── init ─────────────────────────────────────────────────────────────────

function ensure() {
  if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });
  for (const sec of VALID_SECTIONS) {
    const dir = path.join(KB_DIR, sec);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure INDEX.md exists.
  const idx = path.join(KB_DIR, INDEX_FILE);
  if (!fs.existsSync(idx)) {
    const tpl = [
      '# BOOS 共享知识库',
      '',
      '> 自动维护 — agent 完成任务后强制更新对应条目',
      '',
      '## 目录',
      ...VALID_SECTIONS.map((s) => `- [${s}/](./${s}/)`),
      '',
      '## 最近更新',
      '',
    ].join('\n');
    fs.writeFileSync(idx, tpl, 'utf-8');
  }
}

// ── read ─────────────────────────────────────────────────────────────────

function readEntry(relativePath) {
  const clean = _cleanPath(relativePath);
  if (!clean) return { ok: false, error: 'invalid path' };
  const fp = path.join(KB_DIR, clean);
  if (!fs.existsSync(fp)) return { ok: false, error: 'not found: ' + clean };
  const st = fs.statSync(fp);
  if (st.isDirectory()) return _listDir(clean, fp);
  const raw = fs.readFileSync(fp, 'utf-8');
  return {
    ok: true,
    path: clean,
    content: raw,
    size: raw.length,
    updated_at: st.mtime.toISOString(),
  };
}

// ── write / update ───────────────────────────────────────────────────────

function writeEntry(relativePath, content, opts = {}) {
  const clean = _cleanPath(relativePath);
  if (!clean) return { ok: false, error: 'invalid path' };
  if (typeof content !== 'string' || content.length > MAX_FILE_SIZE) {
    return { ok: false, error: 'content too large (max ' + MAX_FILE_SIZE + ' bytes)' };
  }

  const fp = path.join(KB_DIR, clean);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const isNew = !fs.existsSync(fp);
  const prev = isNew ? '' : fs.readFileSync(fp, 'utf-8');

  // Append mode: add to existing content with timestamp marker.
  const ts = new Date().toISOString();
  const header = opts.append
    ? `\n\n---\n## ${opts.author || 'agent'} · ${ts}\n`
    : '';
  const finalContent = opts.append ? prev + header + content : content;

  fs.writeFileSync(fp, finalContent, 'utf-8');

  // Update INDEX.md with this entry.
  _touchIndex(clean, ts);

  return {
    ok: true,
    path: clean,
    updated_at: ts,
    is_new: isNew,
    size: finalContent.length,
  };
}

// ── list ─────────────────────────────────────────────────────────────────

function listSection(section) {
  if (section && !VALID_SECTIONS.includes(section)) {
    return { ok: false, error: 'unknown section: ' + section + '. Valid: ' + VALID_SECTIONS.join(', ') };
  }
  const base = section ? path.join(KB_DIR, section) : KB_DIR;
  if (!fs.existsSync(base)) return { ok: true, entries: [], section };
  return _listDir(section || '', base);
}

// ── search ───────────────────────────────────────────────────────────────

function search(query) {
  if (!query || query.length < 2) return { ok: false, error: 'query too short (min 2 chars)' };
  const results = [];
  const lower = query.toLowerCase();
  _walk(KB_DIR, (fp, rel) => {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lower)) {
          results.push({
            path: rel,
            line: i + 1,
            snippet: lines[i].slice(0, 200),
          });
          if (results.length >= 50) return true; // stop walking
        }
      }
    } catch {}
    return false;
  });
  return { ok: true, query, results, count: results.length };
}

// ── helpers ──────────────────────────────────────────────────────────────

function _cleanPath(p) {
  if (!p || typeof p !== 'string') return null;
  // Reject path traversal.
  if (p.includes('..')) return null;
  // Strip leading slash, normalize.
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function _listDir(rel, dir) {
  const entries = [];
  const items = fs.readdirSync(dir);
  for (const name of items) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    entries.push({
      name,
      path: rel ? rel + '/' + name : name,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : undefined,
      updated_at: st.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { ok: true, entries, path: rel || '', count: entries.length };
}

function _touchIndex(entryPath, ts) {
  try {
    const idx = path.join(KB_DIR, INDEX_FILE);
    let content = fs.readFileSync(idx, 'utf-8');
    const marker = '## 最近更新';
    const idx2 = content.indexOf(marker);
    if (idx2 === -1) return;
    const before = content.slice(0, idx2 + marker.length);
    // Prepend new entry.
    const line = `\n- \`${ts.slice(0, 19).replace('T', ' ')}\` [${entryPath}](./${entryPath})`;
    content = before + line + content.slice(idx2 + marker.length);
    // Keep max 100 recent entries.
    const lines = content.split('\n');
    const afterMarker = lines.findIndex((l, i) => i > 0 && l.startsWith('## 最近更新'));
    const recentStart = afterMarker + 1;
    let recentLines = lines.slice(recentStart).filter((l) => l.startsWith('- '));
    if (recentLines.length > 100) recentLines = recentLines.slice(0, 100);
    content = [...lines.slice(0, recentStart), ...recentLines].join('\n');
    fs.writeFileSync(idx, content, 'utf-8');
  } catch {}
}

function _walk(dir, cb) {
  let items;
  try { items = fs.readdirSync(dir); } catch { return; }
  for (const name of items) {
    if (name === INDEX_FILE) continue;
    const fp = path.join(dir, name);
    const rel = path.relative(KB_DIR, fp).replace(/\\/g, '/');
    try {
      if (fs.statSync(fp).isDirectory()) { _walk(fp, cb); continue; }
      if (cb(fp, rel)) return;
    } catch {}
  }
}

// ── on task completion hook ──────────────────────────────────────────────

// Called by notifications.js after respond_task completes.
// Updates the agents/<name>.md file with the task result summary.
function recordTaskCompletion(agentName, taskId, summary) {
  ensure();
  const slug = agentName.replace(/[<>:"/\\|?*]/g, '_');
  const ts = new Date().toISOString();
  const entry = `\n- \`${ts.slice(0, 19).replace('T', ' ')}\` #${taskId}: ${summary.slice(0, 200)}`;
  return writeEntry('agents/' + slug + '.md', entry, { append: true, author: agentName });
}

module.exports = {
  ensure, readEntry, writeEntry, listSection, search, recordTaskCompletion,
  KB_DIR, VALID_SECTIONS,
};
