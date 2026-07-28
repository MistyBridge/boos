// Per-CLI session-id detectors and process-tree utilities.
//
// Extracted from sessionBinding.js (Sprint 31 refactor — ≤500 lines).
// Detectors scan each CLI's runtime traces to discover the upstream session id.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

// ── Process tree snapshot ───────────────────────────────────────────────

function runCapture(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch { finish(''); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {}; finish(out); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

async function snapshotWindows() {
  const csv = await runCapture('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
  ]);
  const tree = new Map();
  if (!csv) return tree;
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"?(\d+)"?,"?(\d+)"?\s*$/);
    if (m) tree.set(Number(m[1]), Number(m[2]));
  }
  return tree;
}

async function snapshotPosix() {
  const out = await runCapture('ps', ['-eo', 'pid=,ppid=']);
  const tree = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/);
    if (m) tree.set(Number(m[1]), Number(m[2]));
  }
  return tree;
}

function snapshotProcessTree() {
  return process.platform === 'win32' ? snapshotWindows() : snapshotPosix();
}

function descendantsOf(root, tree) {
  const result = new Set();
  if (!Number.isFinite(root)) return result;
  result.add(root);
  const children = new Map();
  for (const [pid, ppid] of tree) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of children.get(cur) || []) {
      if (!result.has(child)) { result.add(child); stack.push(child); }
    }
  }
  return result;
}

// ── FS helpers ─────────────────────────────────────────────────────────

function sameCwd(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); }
  catch { return false; }
}

async function readFirstLine(file, maxBytes = 512 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const chunk = Buffer.alloc(32 * 1024);
    let acc = '', pos = 0;
    while (pos < maxBytes) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      acc += chunk.toString('utf8', 0, bytesRead);
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
      pos += bytesRead;
    }
    return acc;
  } catch { return ''; }
  finally { if (fh) { try { await fh.close(); } catch {} } }
}

async function readFirstLines(file, maxLines = 10, maxBytes = 1024 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const chunk = Buffer.alloc(32 * 1024);
    let acc = '', pos = 0, lines = 0;
    while (pos < maxBytes && lines < maxLines) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (!bytesRead) break;
      acc += chunk.toString('utf8', 0, bytesRead);
      lines = (acc.match(/\n/g) || []).length;
      pos += bytesRead;
    }
    return acc;
  } catch { return ''; }
  finally { if (fh) { try { await fh.close(); } catch {} } }
}

// ── Claude detector ────────────────────────────────────────────────────

async function detectClaude(descSet, cwd) {
  // Primary: PID-based scan (~/.claude/sessions/<pid>.json).
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let names;
  try { names = await fsp.readdir(dir); } catch { names = []; }
  const candidates = [];
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!descSet.has(pid)) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (j && j.sessionId) candidates.push({ sessionId: j.sessionId, cwd: j.cwd, updatedAt: j.updatedAt || 0 });
    } catch {}
  }
  if (candidates.length) {
    const cwdMatches = candidates.filter((c) => sameCwd(c.cwd, cwd));
    const pool = cwdMatches.length ? cwdMatches : candidates;
    pool.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { sessionId: pool[0].sessionId || null, projectSlug: null };
  }

  // Fallback: project-dir scan (~/.claude/projects/<slug>/<uuid>.jsonl).
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let slugs;
  try { slugs = await fsp.readdir(projectsDir, { withFileTypes: true }); } catch { return null; }
  const jsonlCandidates = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(projectsDir, slug.name);
    let files;
    try { files = await fsp.readdir(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      const uuidMatch = f.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      if (!uuidMatch || !f.isFile()) continue;
      let stat;
      try { stat = await fsp.stat(path.join(slugDir, f.name)); } catch { continue; }
      const headText = await readFirstLines(path.join(slugDir, f.name), 10);
      if (!headText) continue;
      let objCwd = null;
      for (const line of headText.split('\n')) {
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        objCwd = (obj && obj.cwd) || (obj.payload && obj.payload.cwd)
          || (obj.session_meta && obj.session_meta.cwd)
          || ((obj.payload && obj.payload.session_meta && obj.payload.session_meta.cwd));
        if (objCwd) break;
      }
      if (!objCwd) continue;
      jsonlCandidates.push({ sessionId: uuidMatch[1], projectSlug: slug.name, cwd: objCwd, mtimeMs: stat.mtimeMs });
    }
  }
  if (!jsonlCandidates.length) return null;
  const norm = (p) => { try { return path.resolve(String(p || '')).toLowerCase().replace(/\\/g, '/'); } catch { return String(p || '').toLowerCase().replace(/\\/g, '/'); } };
  const targetNorm = norm(cwd);
  const cwdMatches = jsonlCandidates.filter((c) => norm(c.cwd) === targetNorm);
  const pool = cwdMatches.length ? cwdMatches : jsonlCandidates;
  pool.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  if (!pool[0] || !pool[0].sessionId) return null;
  return { sessionId: pool[0].sessionId, projectSlug: pool[0].projectSlug || null };
}

// ── Copilot detector ───────────────────────────────────────────────────

async function detectCopilot(descSet) {
  const dir = path.join(os.homedir(), '.copilot', 'logs');
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  const matches = [];
  for (const name of names) {
    const m = name.match(/^process-(\d+)-(\d+)\.log$/);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!descSet.has(pid)) continue;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dir, name))).mtimeMs; } catch {}
    matches.push({ file: path.join(dir, name), mtime });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of matches) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const ids = text.match(/Workspace initialized:\s*([0-9a-f-]{36})/gi);
    if (ids && ids.length) {
      const last = ids[ids.length - 1].match(/([0-9a-f-]{36})/i);
      if (last) return last[1];
    }
  }
  return null;
}

// ── Codex detector ─────────────────────────────────────────────────────

const CODEX_RECENT_MS = 15 * 60 * 1000;
let _codexHomesCache = null;
let _codexHomesAt = 0;

function listChildDirsSync(base) {
  try { return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}

function codexSessionRoots() {
  const now = Date.now();
  if (_codexHomesCache && now - _codexHomesAt < 60_000) return _codexHomesCache;
  const homes = new Set();
  if (process.env.CODEX_HOME) homes.add(process.env.CODEX_HOME);
  homes.add(path.join(os.homedir(), '.codex'));
  const bases = [process.env.LOCALAPPDATA, process.env.APPDATA, os.homedir()].filter(Boolean);
  for (const base of bases) {
    for (const child of listChildDirsSync(base)) {
      const cand = path.join(base, child, 'codex-home');
      try { if (fs.existsSync(path.join(cand, 'sessions'))) homes.add(cand); } catch {}
    }
  }
  const roots = [...homes].map((h) => path.join(h, 'sessions'));
  _codexHomesCache = roots;
  _codexHomesAt = now;
  return roots;
}

async function* walkRollouts(root, sinceMs) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) { yield* walkRollouts(full, sinceMs); }
    else if (/^rollout-.*\.jsonl$/.test(ent.name)) {
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.mtimeMs >= sinceMs) yield { file: full, mtime: stat.mtimeMs };
    }
  }
}

async function detectCodex(descSet, cwd, opts = {}) {
  const excludeIds = new Set((opts.excludeIds || []).filter(Boolean).map(String));
  const since = Date.now() - CODEX_RECENT_MS;
  const recent = [];
  for (const root of codexSessionRoots()) {
    for await (const r of walkRollouts(root, since)) recent.push(r);
  }
  if (!recent.length) return null;
  recent.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of recent) {
    const firstLine = await readFirstLine(file);
    if (!firstLine) continue;
    let meta;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    const payload = meta && (meta.payload || meta);
    const metaCwd = payload && (payload.cwd || (payload.session_meta && payload.session_meta.cwd));
    const id = payload && (payload.id || (payload.session_meta && payload.session_meta.id));
    if (id && sameCwd(metaCwd, cwd) && !excludeIds.has(String(id))) return id;
  }
  return null;
}

// ── Unified detect ─────────────────────────────────────────────────────

async function detect(type, ptyPid, cwd, tree, opts = {}) {
  const desc = descendantsOf(Number(ptyPid), tree || new Map());
  switch (type) {
    case 'claude': {
      const r = await detectClaude(desc, cwd);
      return r; // { sessionId, projectSlug } | null
    }
    case 'copilot': {
      const sid = await detectCopilot(desc);
      return sid ? { sessionId: sid, projectSlug: null } : null;
    }
    case 'codex': {
      const sid = await detectCodex(desc, cwd, opts);
      return sid ? { sessionId: sid, projectSlug: null } : null;
    }
    default: return null;
  }
}

function supports(type) {
  return type === 'claude' || type === 'copilot' || type === 'codex';
}

module.exports = {
  snapshotProcessTree, descendantsOf, sameCwd, readFirstLine, readFirstLines,
  detectClaude, detectCopilot, detectCodex,
  detect, supports,
};
