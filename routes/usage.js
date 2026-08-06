// Usage + prompt-cache telemetry routes.
//
// Source of truth: Claude Code writes per-session JSONL transcripts under
// ~/.claude/projects/<slug>/<uuid>.jsonl. Every assistant message carries a
// `usage` object:
//   { input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
//     output_tokens, ... }
//
// This route aggregates those files (matched to BOOS sessions via
// cliSessionId → projectSlug) into per-session + workspace-wide stats:
//   - total input / output tokens
//   - cache read / creation tokens
//   - prompt-cache hit rate = cache_read / (input + cache_read + cache_creation)
//
// Cache hit rate is the key health metric for BOOS agent sessions — a low
// rate means the tool-definition prefix is drifting (see Sprint 41 Router
// Mode fix).

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Parse a single JSONL transcript, summing usage across assistant messages.
// Returns { counts, series } where series is per-message chronological
// (with timestamps for trend charts).
// maxMsgs caps the TOTAL parse (totals + series) — used to bound work on
// huge files. seriesLimit (if > 0) keeps only the LAST seriesLimit entries.
function parseTranscript(file, maxMsgs = 100000, seriesLimit = 0) {
  let total = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
  const series = [];
  let lineNo = 0;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      if (++lineNo > maxMsgs) break;
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      // Claude Code transcript: usage lives on obj.message.usage
      // (assistant messages only — tool_result echoes lack usage).
      const usage = obj.message?.usage || obj.usage;
      if (!usage) continue;
      total.input += usage.input_tokens || 0;
      total.cacheRead += usage.cache_read_input_tokens || 0;
      total.cacheCreation += usage.cache_creation_input_tokens || 0;
      total.output += usage.output_tokens || 0;
      total.msgs++;

      // Dedupe: Claude Code replays messages on retry, writing identical
      // usage rows back-to-back (57% of rows were duplicates in testing).
      // Series should show one bar per distinct event, not per retry echo.
      const pt = {
        t: obj.timestamp || obj.created_at || null,
        input: usage.input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        output: usage.output_tokens || 0,
      };
      const last = series[series.length - 1];
      if (last && last.input === pt.input && last.output === pt.output
          && last.cacheRead === pt.cacheRead && last.cacheCreation === pt.cacheCreation) {
        continue;   // exact retry echo — skip
      }

      // Rolling window: keep only the last seriesLimit entries.
      if (seriesLimit > 0) {
        if (series.length >= seriesLimit) series.shift();
        series.push(pt);
      } else {
        series.push(pt);
      }
    }
  } catch { /* file gone mid-read — return what we have */ }
  return { total, series };
}

function hitRate({ input, cacheRead, cacheCreation }) {
  const denom = input + cacheRead + cacheCreation;
  return denom === 0 ? null : Math.round((cacheRead / denom) * 1000) / 10;
}

// Resolve the transcript path for a session record.
// Prefers projectSlug (persisted by sessionBinding) → falls back to scanning
// projects dir for a matching <uuid>.jsonl.
function transcriptPath(record) {
  if (record.projectSlug) {
    const p = path.join(PROJECTS_DIR, record.projectSlug, `${record.cliSessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  if (!record.cliSessionId) return null;
  try {
    const slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const p = path.join(PROJECTS_DIR, slug.name, `${record.cliSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no projects dir */ }
  return null;
}

function register(app, { asyncH, persistedSessions }) {

  // ---- aggregate usage across all sessions ----
  app.get('/api/usage', asyncH(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const all = await persistedSessions.loadAll();

    const sessions = [];
    const workspace = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
    const workspaceRecent = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
    const RECENT_WINDOW = 100;   // last N messages per session — current-window stats
    let withTranscript = 0;

    for (const record of all) {
      const p = transcriptPath(record);
      if (!p) continue;
      // Full parse for totals; series trimmed to RECENT_WINDOW + sparkline.
      const { total, series } = parseTranscript(p, 1000000, 100);
      if (total.msgs === 0) continue;
      withTranscript++;
      workspace.input += total.input;
      workspace.cacheRead += total.cacheRead;
      workspace.cacheCreation += total.cacheCreation;
      workspace.output += total.output;
      workspace.msgs += total.msgs;

      // Recent window: last RECENT_WINDOW messages of this session.
      const recent = series.slice(-RECENT_WINDOW).reduce((a, s) => {
        a.input += s.input; a.cacheRead += s.cacheRead;
        a.cacheCreation += s.cacheCreation; a.output += s.output; a.msgs++;
        return a;
      }, { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 });
      workspaceRecent.input += recent.input;
      workspaceRecent.cacheRead += recent.cacheRead;
      workspaceRecent.cacheCreation += recent.cacheCreation;
      workspaceRecent.output += recent.output;
      workspaceRecent.msgs += recent.msgs;

      sessions.push({
        id: record.id,
        cliId: record.cliId,
        cwd: record.cwd,
        title: record.title || null,
        status: record.status || 'unknown',
        updatedAt: record.updatedAt || null,
        projectSlug: record.projectSlug || null,
        usage: total,
        hitRate: hitRate(total),
        recent: { ...recent, hitRate: hitRate(recent) },   // current-window stats
        series: series.slice(-60),   // last 60 messages for sparkline
      });
    }

    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    res.json({
      generatedAt: new Date().toISOString(),
      workspace: {
        ...workspace, hitRate: hitRate(workspace), sessions: withTranscript,
        recent: { ...workspaceRecent, hitRate: hitRate(workspaceRecent) },
      },
      sessions,
    });
  }));

  // ---- single-session detail ----
  app.get('/api/usage/:id', asyncH(async (req, res) => {
    const record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });
    const p = transcriptPath(record);
    if (!p) return res.status(404).json({ error: 'no transcript found for session' });
    const { total, series } = parseTranscript(p, 100000);
    res.json({
      id: record.id,
      projectSlug: record.projectSlug,
      cliSessionId: record.cliSessionId,
      usage: total,
      hitRate: hitRate(total),
      series,
    });
  }));
}

module.exports = { register, parseTranscript, transcriptPath, hitRate };
