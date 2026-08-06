// Unit tests for routes/usage.js — token + cache telemetry parsing.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTranscript, hitRate } = require('../routes/usage');

// ── helpers ──────────────────────────────────────────────────────────────

function makeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return file;
}

const MSG = (usage, extra = {}) => JSON.stringify({
  type: 'assistant',
  message: { id: 'msg_x', role: 'assistant', usage, ...extra },
});

// ── parseTranscript ──────────────────────────────────────────────────────

test('parseTranscript: sums usage across assistant messages', () => {
  const file = makeTranscript([
    MSG({ input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 50, output_tokens: 20 }),
    MSG({ input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 40 }),
  ]);
  const { total, series } = parseTranscript(file);
  assert.strictEqual(total.msgs, 2);
  assert.strictEqual(total.input, 300);
  assert.strictEqual(total.cacheRead, 1500);
  assert.strictEqual(total.cacheCreation, 150);
  assert.strictEqual(total.output, 60);
  assert.strictEqual(series.length, 2);
});

test('parseTranscript: ignores lines without usage (user msgs, tool results)', () => {
  const file = makeTranscript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    MSG({ input_tokens: 10, output_tokens: 5 }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  ]);
  const { total } = parseTranscript(file);
  assert.strictEqual(total.msgs, 1);
  assert.strictEqual(total.input, 10);
});

test('parseTranscript: handles corrupt lines + missing file', () => {
  const file = makeTranscript(['{corrupt', MSG({ input_tokens: 7 }), '']);
  const { total } = parseTranscript(file);
  assert.strictEqual(total.msgs, 1);
  assert.strictEqual(total.input, 7);

  const empty = parseTranscript(path.join(os.tmpdir(), 'does-not-exist-usage-test.jsonl'));
  assert.strictEqual(empty.total.msgs, 0);
});

test('parseTranscript: respects maxMsgs cap', () => {
  const lines = Array.from({ length: 10 }, (_, i) =>
    MSG({ input_tokens: i + 1, output_tokens: 1 }));
  const file = makeTranscript(lines);
  const { total, series } = parseTranscript(file, 4);
  assert.strictEqual(total.msgs, 4);
  assert.strictEqual(series.length, 4);
});

test('parseTranscript: seriesLimit keeps only last N (totals stay full)', () => {
  const lines = Array.from({ length: 10 }, (_, i) =>
    MSG({ input_tokens: i + 1, output_tokens: 1 }));
  const file = makeTranscript(lines);
  const { total, series } = parseTranscript(file, 100000, 3);
  assert.strictEqual(total.msgs, 10, 'totals count ALL messages');
  assert.strictEqual(total.input, 55, 'totals sum ALL messages');
  assert.strictEqual(series.length, 3, 'series trimmed to window');
  assert.strictEqual(series[2].input, 10, 'series holds the LAST entries');
});

test('parseTranscript: handles legacy top-level usage (no message wrapper)', () => {
  const file = makeTranscript([
    JSON.stringify({ type: 'assistant', usage: { input_tokens: 42, output_tokens: 3 } }),
  ]);
  const { total } = parseTranscript(file);
  assert.strictEqual(total.input, 42);
  assert.strictEqual(total.msgs, 1);
});

// ── hitRate ──────────────────────────────────────────────────────────────

test('hitRate: standard formula', () => {
  // cache_read / (input + read + creation)
  assert.strictEqual(hitRate({ input: 100, cacheRead: 900, cacheCreation: 100 }), 81.8);
  assert.strictEqual(hitRate({ input: 0, cacheRead: 0, cacheCreation: 0 }), null);
  assert.strictEqual(hitRate({ input: 0, cacheRead: 100, cacheCreation: 0 }), 100);
});

test('hitRate: rounds to one decimal', () => {
  assert.strictEqual(hitRate({ input: 1, cacheRead: 2, cacheCreation: 0 }), 66.7);
});
