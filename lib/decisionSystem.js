// Non-blocking Decision System — Agents write .md files for human review.
//
// Decisions live in ~/.boos/decisions/OPEN/ and move to DECIDED/ on approval/rejection.
// Urgent decisions trigger Feishu webhook (if configured).
//
// MCP Tools: request_decision, check_decisions
// REST API: routes/decisions.js

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { DATA_DIR } = require('./config');

const DECISIONS_DIR = path.join(DATA_DIR, 'decisions');
const OPEN_DIR = path.join(DECISIONS_DIR, 'OPEN');
const DECIDED_DIR = path.join(DECISIONS_DIR, 'DECIDED');

// ── init ───────────────────────────────────────────────────────────────

function _ensureDirs() {
  for (const d of [DECISIONS_DIR, OPEN_DIR, DECIDED_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function _genId() {
  return 'dec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function _safeFilename(title) {
  return String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

// Sprint 12 C6: find existing open decision with matching merge_group
// from the same agent within the current window.
function _findMergeTarget(mergeGroup, agentUid) {
  try {
    const files = fs.readdirSync(OPEN_DIR);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(OPEN_DIR, f), 'utf-8');
      const fm = _parseFrontMatter(raw);
      const m = fm && fm.meta;
      if (m && m.merge_group === mergeGroup && m.agent_uid === agentUid && m.status === 'open') {
        return { id: fm.decision_id, path: path.join(OPEN_DIR, f) };
      }
    }
  } catch {}
  return null;
}

// ── YAML front matter ──────────────────────────────────────────────────

function _formatFrontMatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function _parseFrontMatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    // Keep strings as strings.
    meta[kv[1]] = typeof val === 'boolean' ? val : String(val);
  }
  return { meta, body: raw.slice(m[0].length) };
}

// ── CRUD ────────────────────────────────────────────────────────────────

function createDecision({ agent_uid, agent_name, workspace, title, content, urgent, blocking_task_id, merge_group }) {
  _ensureDirs();
  const now = new Date().toISOString();

  // Sprint 12 C6: merge_group — if a recent open decision with same
  // merge_group exists, append content to it instead of creating a new file.
  if (merge_group) {
    const existing = _findMergeTarget(merge_group, agent_uid);
    if (existing) {
      const appendContent = '\n\n---\n## ' + (title || '补充') + '\n' + (content || '');
      fs.appendFileSync(existing.path, appendContent, 'utf-8');
      return {
        ok: true,
        decision_id: existing.id,
        file_path: existing.path,
        merged: true,
        merge_group,
      };
    }
  }

  const decId = _genId();
  const isUrgent = !!urgent;

  const meta = {
    decision_id: decId,
    title: String(title || '').slice(0, 128),
    agent_uid,
    agent_name: String(agent_name || '').slice(0, 64),
    workspace: String(workspace || ''),
    status: 'open',
    urgent: isUrgent,
    blocking_task_id: String(blocking_task_id || '') || null,  // Sprint 9
    merge_group: merge_group || null,  // Sprint 12 C6
    created_at: now,
    decided_at: null,
    approver: null,
    comment: null,
  };

  const frontMatter = _formatFrontMatter(meta);
  const mdContent = `${frontMatter}\n${String(content || '')}\n`;
  const filename = `${decId}-${_safeFilename(title)}.md`;
  const filePath = path.join(OPEN_DIR, filename);

  fs.writeFileSync(filePath, mdContent, 'utf-8');

  // Fire-and-forget Feishu notification for urgent decisions.
  if (isUrgent) {
    _feishuNotify(meta).catch((e) => console.warn('[decisions] feishu notify failed:', e.message));
  }

  return { ok: true, decision_id: decId, file_path: filePath, urgent: isUrgent };
}

function listDecisions({ workspace, status, limit }) {
  _ensureDirs();
  const results = [];
  const dirs = [];
  const filterStatus = status || 'open';

  if (filterStatus === 'open' || filterStatus === 'all') {
    if (fs.existsSync(OPEN_DIR)) dirs.push({ dir: OPEN_DIR, status: 'open' });
  }
  if (filterStatus === 'decided' || filterStatus === 'all') {
    if (fs.existsSync(DECIDED_DIR)) dirs.push({ dir: DECIDED_DIR, status: 'decided' });
  }

  for (const { dir, status: fileStatus } of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
        const { meta } = _parseFrontMatter(raw);
        if (workspace && meta.workspace !== workspace) continue;
        results.push({
          ...meta,
          status: fileStatus,
          filename: name,
          urgent: meta.urgent === true || meta.urgent === 'true',
        });
      } catch {}
    }
  }

  results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return { decisions: results.slice(0, limit || 20), count: results.length };
}

function getDecision(decisionId) {
  _ensureDirs();
  for (const dir of [OPEN_DIR, DECIDED_DIR]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(decisionId) || !name.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
      const { meta, body } = _parseFrontMatter(raw);
      return { metadata: meta, markdown: body };
    }
  }
  return { metadata: null, markdown: '' };
}

function _moveDecision(dir, decisionId, updates) {
  _ensureDirs();
  let found = null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(decisionId) || !name.endsWith('.md')) continue;
    found = name;
    break;
  }
  if (!found) return null;

  const srcPath = path.join(dir, found);
  const raw = fs.readFileSync(srcPath, 'utf-8');
  const { meta, body } = _parseFrontMatter(raw);

  Object.assign(meta, updates);

  const frontMatter = _formatFrontMatter(meta);
  const newContent = `${frontMatter}\n${body}`;
  const dstPath = path.join(DECIDED_DIR, found);

  fs.writeFileSync(dstPath, newContent, 'utf-8');
  fs.unlinkSync(srcPath);
  return meta;
}

function approveDecision(decisionId, approver, comment) {
  const meta = _moveDecision(OPEN_DIR, decisionId, {
    status: 'approved',
    approver: String(approver || 'host').slice(0, 64),
    comment: String(comment || '').slice(0, 256),
    decided_at: new Date().toISOString(),
  });
  if (!meta) return { ok: false, error: 'decision not found in OPEN' };
  return { ok: true, decision_id: decisionId, status: 'approved', approver, comment: comment || '' };
}

function rejectDecision(decisionId, approver, comment) {
  const meta = _moveDecision(OPEN_DIR, decisionId, {
    status: 'rejected',
    approver: String(approver || 'host').slice(0, 64),
    comment: String(comment || '').slice(0, 256),
    decided_at: new Date().toISOString(),
  });
  if (!meta) return { ok: false, error: 'decision not found in OPEN' };
  return { ok: true, decision_id: decisionId, status: 'rejected', approver, comment };
}

// ── Feishu webhook (delegated to lib/feishu.js) ────────────────────────

async function _feishuNotify(meta) {
  const { sendFeishuCardFromConfig } = require('./feishu');
  sendFeishuCardFromConfig({
    title: meta.title,
    content: '',
    agentName: meta.agent_name,
    workspace: meta.workspace,
    urgent: meta.urgent,
    decisionId: meta.decision_id,
  }).catch(() => {}); // fire-and-forget
}

module.exports = {
  createDecision,
  listDecisions,
  getDecision,
  approveDecision,
  rejectDecision,
};
