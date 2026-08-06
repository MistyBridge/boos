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
const errReport = require("../lib/errorReport");

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const usageLedger = require('../lib/usageLedger');   // Sprint 42: cumulative monotonic totals

// Parse a single JSONL transcript, summing usage across assistant messages.
// Returns { counts, series } where series is per-message chronological
// (with timestamps for trend charts).
// maxMsgs caps the TOTAL parse (totals + series) — used to bound work on
// huge files. seriesLimit (if > 0) keeps only the LAST seriesLimit entries.
// skipUsage skips the first N usage rows (ledger cursor — rows already
// counted in a previous scan); usageMsgs returns the file's total usage-row
// count so the caller can advance the cursor.
function parseTranscript(file, maxMsgs = 100000, seriesLimit = 0, skipUsage = 0, onUsage = null) {
  let total = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
  const series = [];
  let lineNo = 0;
  let usageMsgs = 0;
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
      usageMsgs++;
      if (usageMsgs <= skipUsage) continue;   // already counted — skip

      total.input += usage.input_tokens || 0;
      total.cacheRead += usage.cache_read_input_tokens || 0;
      total.cacheCreation += usage.cache_creation_input_tokens || 0;
      total.output += usage.output_tokens || 0;
      total.msgs++;

      // Trend aggregation hook (Sprint 42): called once per counted usage
      // row with its timestamp — lets callers bucket into time series
      // without retaining the full per-message series in memory.
      if (onUsage) {
        try { onUsage(obj.timestamp || obj.created_at || null, usage); } catch { /* never break parse */ }
      }

      // Only build series when the caller actually needs them.
      // Callers that pass seriesLimit === 0 use onUsage for aggregation
      // and discard the returned series — skip the work.
      if (seriesLimit > 0) {
        // Dedupe: Claude Code replays messages on retry, writing identical
        // usage rows back-to-back (57% of rows were duplicates in testing).
        const pt = {
          t: obj.timestamp || obj.created_at || null,
          input: usage.input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          cacheCreation: usage.cache_creation_input_tokens || 0,
          output: usage.output_tokens || 0,
        };
        const last = series[series.length - 1];
        if (!(last && last.input === pt.input && last.output === pt.output
            && last.cacheRead === pt.cacheRead && last.cacheCreation === pt.cacheCreation)) {
          if (series.length >= seriesLimit) series.shift();
          series.push(pt);
        }
      }
    }
  } catch { /* file gone mid-read — return what we have */ }
  return { total, series, usageMsgs };
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

// Scan ALL transcripts on disk — the source of truth for cumulative usage.
// Session records come and go (BOOS sessions can be deleted), but the
// JSONL transcripts persist under ~/.claude/projects/<slug>/<uuid>.jsonl.
// Counting only live records undercounts real usage after session deletion.
function scanAllTranscripts() {
  const found = [];
  try {
    const slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(path.join(PROJECTS_DIR, slug.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const uuid = f.slice(0, -6);
        if (!/^[0-9a-fA-F-]{20,64}$/.test(uuid)) continue;
        found.push({ file: path.join(PROJECTS_DIR, slug.name, f), slug: slug.name, uuid });
      }
    }
  } catch { /* no projects dir */ }
  return found;
}

// Bucket a timestamp to its granularity slot (local time).
// minute/hour/day floor to the unit; week starts Monday; month floors to the 1st.
function bucketKey(ts, granularity) {
  const d = new Date(ts);
  switch (granularity) {
    case 'minute': d.setSeconds(0, 0); break;
    case 'hour': d.setMinutes(0, 0, 0); break;
    case 'day': d.setHours(0, 0, 0, 0); break;
    case 'week': { const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); break; }
    case 'month': d.setDate(1); d.setHours(0, 0, 0, 0); break;
    default: d.setMinutes(0, 0, 0);
  }
  return d.getTime();
}

// ---- time-bucketed usage trend (Sprint 42) ----
// Granularity: month | week | day | hour | minute. Returns the most recent
// N buckets across ALL transcripts (deleted sessions included).
function registerTrendRoute(app, asyncH) {
  app.get('/api/usage/trend', asyncH(async (req, res) => {
    const granularity = ['month', 'week', 'day', 'hour', 'minute'].includes(req.query.granularity)
      ? req.query.granularity : 'hour';
    const DEFAULT_BUCKETS = { minute: 60, hour: 24, day: 30, week: 12, month: 12 };
    const buckets = Math.min(parseInt(req.query.buckets, 10) || DEFAULT_BUCKETS[granularity], 500);

    const bins = new Map();
    const transcripts = scanAllTranscripts();
    for (const t of transcripts) {
      parseTranscript(t.file, 1000000, 0, 0, (ts, usage) => {
        let time;
        try { time = ts ? new Date(ts).getTime() : NaN; } catch { time = NaN; }
        if (!Number.isFinite(time)) return;
        const key = bucketKey(time, granularity);
        let b = bins.get(key);
        if (!b) { b = { t: key, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }; bins.set(key, b); }
        b.input += usage.input_tokens || 0;
        b.cacheRead += usage.cache_read_input_tokens || 0;
        b.cacheCreation += usage.cache_creation_input_tokens || 0;
        b.output += usage.output_tokens || 0;
      });
    }

    const sorted = [...bins.values()].sort((a, b) => a.t - b.t).slice(-buckets);
    res.json({
      granularity, buckets: sorted, count: sorted.length,
      generatedAt: new Date().toISOString(),
    });
  }));
}

function register(app, { asyncH, persistedSessions }) {

  // ---- aggregate usage across ALL transcripts on disk ----
  app.get('/api/usage', asyncH(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const all = await persistedSessions.loadAll();
    // Map cliSessionId → record so transcripts can be matched (or marked
    // as orphaned when their BOOS session record was deleted).
    const recordByUid = new Map();
    for (const rec of all) {
      if (rec.cliSessionId) recordByUid.set(rec.cliSessionId, rec);
    }

    const sessions = [];
    const workspace = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
    const workspaceRecent = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };
    const RECENT_WINDOW = 100;   // last N messages per session — current-window stats
    let withTranscript = 0;

    // Source of truth is the transcript files, not the live session records:
    // deleted sessions keep counting toward cumulative usage.
    const transcripts = scanAllTranscripts();
    for (const t of transcripts) {
      const record = recordByUid.get(t.uuid) || null;
      // Full parse for totals; series trimmed to RECENT_WINDOW + sparkline.
      const { total, series } = parseTranscript(t.file, 1000000, 100);
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
        id: record ? record.id : `tx-${t.slug}-${t.uuid.slice(0, 8)}`,
        cliId: record ? record.cliId : 'claude',
        cwd: record ? record.cwd : null,
        title: record ? record.title : null,
        status: record ? record.status : 'deleted',
        updatedAt: record ? record.updatedAt : null,
        projectSlug: t.slug,
        orphan: !record,   // transcript exists but BOOS session record was deleted
        usage: total,
        hitRate: hitRate(total),
        recent: { ...recent, hitRate: hitRate(recent) },   // current-window stats
        series: series.slice(-60),   // last 60 messages for sparkline
      });
    }

    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    // ── Sprint 42: cumulative ledger — workspace totals are MONOTONIC.
    // Per-session rows above reflect the current transcript set; the ledger
    // only ever adds increments, so deleted/shrunk transcripts never reduce
    // the reported totals.
    const ledger = usageLedger.update(transcripts, (file, skip) =>
      parseTranscript(file, 1000000, 0, skip));
    const cumulative = ledger.totals;

    // ---- Sprint 42: reset cumulative ledger to current-scan baseline ----
    app.post('/api/usage/ledger/reset', asyncH(async (req, res) => {
      // ROOT-only: loopback requests only (local BOOS server).
      const { isDirectLoopback } = require('../lib/middleware');
      if (!isDirectLoopback(req)) {
        return res.status(403).json({ error: 'ROOT permission required — localhost only' });
      }

      const transcripts = scanAllTranscripts();
      const result = usageLedger.rebuildBaseline(transcripts,
        (file, skip) => parseTranscript(file, 1000000, 0, skip));

      res.json({
        ok: true,
        action: 'ledger-reset',
        baseline: result.totals,
        files: Object.keys(result.byFile).length,
        updatedAt: result.updatedAt,
      });
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      workspace: {
        ...cumulative, hitRate: hitRate(cumulative), sessions: withTranscript,
        recent: { ...workspaceRecent, hitRate: hitRate(workspaceRecent) },
        current: { ...workspace, hitRate: hitRate(workspace) },   // live snapshot
        cumulative: true,
        ledgerUpdatedAt: ledger.updatedAt,
      },
      sessions,
    });
  }));

  // Sprint 42: time-bucketed usage trend — registered once at startup
  registerTrendRoute(app, asyncH);

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

module.exports = { register, parseTranscript, transcriptPath, hitRate, scanAllTranscripts, bucketKey };
