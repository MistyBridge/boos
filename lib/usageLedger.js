// Usage ledger — cumulative, monotonic token accounting.
//
// User decision (2026-08-06): 总用量只增不减 — cumulative only.
//
// Transcript files (~/.claude/projects/<slug>/<uuid>.jsonl) come and go:
// sessions get deleted, Claude Code cleans old transcripts, compacts may
// rewrite them. Counting the current file set can therefore DECREASE.
// The ledger persists a per-file cursor (number of usage rows already
// counted) so each scan only adds the INCREMENT. Deleted/shrunk files are
// never subtracted.
//
// State: ~/.boos/usage-ledger.json
//   { totals: {input, cacheRead, cacheCreation, output, msgs},
//     byFile: { "<abs path>": { usageMsgs: N } },
//     updatedAt }

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEDGER_PATH = process.env.BOOS_USAGE_LEDGER || path.join(os.homedir(), '.boos', 'usage-ledger.json');

const EMPTY = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, msgs: 0 };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
    return {
      totals: { ...EMPTY, ...(d.totals || {}) },
      byFile: d.byFile || {},
      updatedAt: d.updatedAt || null,
    };
  } catch {
    return { totals: { ...EMPTY }, byFile: {}, updatedAt: null };
  }
}

function save(state) {
  try {
    const tmp = LEDGER_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      totals: state.totals, byFile: state.byFile,
      updatedAt: new Date().toISOString(),
    }, null, 1), 'utf-8');
    fs.renameSync(tmp, LEDGER_PATH);
  } catch (e) {
    console.error('[usageLedger] save failed:', e.message);
  }
}

/**
 * Incremental update over the current transcript set.
 * @param {Array<{file:string}>} transcripts current files on disk
 * @param {(file:string, skipUsage:number) => {total:object, usageMsgs:number}} parseFn
 *   parseFn must skip already-counted usage rows (skipUsage) and return the
 *   file's TOTAL usage-row count for cursor advancement.
 * @returns {{ totals, delta, byFile, updatedAt }} cumulative totals (monotonic)
 */
function update(transcripts, parseFn) {
  const state = load();
  const delta = { ...EMPTY };

  for (const t of transcripts) {
    const prev = state.byFile[t.file];
    const skip = prev ? prev.usageMsgs : 0;
    let parsed;
    try {
      parsed = parseFn(t.file, skip);
    } catch {
      continue; // unreadable — keep cursor untouched
    }
    if (!parsed || !parsed.total) continue;
    delta.input += parsed.total.input || 0;
    delta.cacheRead += parsed.total.cacheRead || 0;
    delta.cacheCreation += parsed.total.cacheCreation || 0;
    delta.output += parsed.total.output || 0;
    delta.msgs += parsed.total.msgs || 0;
    state.byFile[t.file] = { usageMsgs: parsed.usageMsgs || 0 };
  }

  // Cumulative = old ledger totals + this scan's increment. Never decreases.
  const totals = {
    input: state.totals.input + delta.input,
    cacheRead: state.totals.cacheRead + delta.cacheRead,
    cacheCreation: state.totals.cacheCreation + delta.cacheCreation,
    output: state.totals.output + delta.output,
    msgs: state.totals.msgs + delta.msgs,
  };

  save({ totals, byFile: state.byFile });
  return { totals, delta, byFile: state.byFile, updatedAt: new Date().toISOString() };
}

/** Reset the ledger (e.g. for tests or user-initiated recalibration). */
function reset() {
  try { fs.unlinkSync(LEDGER_PATH); } catch {}
  return { totals: { ...EMPTY }, byFile: {}, updatedAt: null };
}

/**
 * Sprint 42: Rebuild the ledger baseline from the current transcript set.
 * Unlike update() which only adds increments, this parses every transcript
 * from scratch (skipUsage=0) and saves the full current totals as the new
 * baseline.  Use when the ledger drifts (e.g. deleted transcripts were
 * overcounted) or after a workspace reset.
 *
 * @param {Array<{file:string}>} transcripts — current files on disk
 * @param {(file:string, skipUsage:number) => {total:object, usageMsgs:number}} parseFn
 * @returns {{ totals, byFile, updatedAt }}
 */
function rebuildBaseline(transcripts, parseFn) {
  const state = { totals: { ...EMPTY }, byFile: {} };
  for (const t of transcripts) {
    let parsed;
    try {
      parsed = parseFn(t.file, 0);   // skipUsage=0 — count everything from scratch
    } catch {
      continue;
    }
    if (!parsed || !parsed.total) continue;
    state.totals.input += parsed.total.input || 0;
    state.totals.cacheRead += parsed.total.cacheRead || 0;
    state.totals.cacheCreation += parsed.total.cacheCreation || 0;
    state.totals.output += parsed.total.output || 0;
    state.totals.msgs += parsed.total.msgs || 0;
    state.byFile[t.file] = { usageMsgs: parsed.usageMsgs || 0 };
  }
  state.updatedAt = new Date().toISOString();
  save(state);
  return { totals: state.totals, byFile: state.byFile, updatedAt: state.updatedAt };
}

module.exports = { update, load, reset, rebuildBaseline, EMPTY, LEDGER_PATH };
