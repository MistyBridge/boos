// Unit tests for lib/usageLedger.js — cumulative monotonic accounting.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../lib/usageLedger');

// ── helpers ──────────────────────────────────────────────────────────────

function fakeParse(byFile) {
  return (file, skip) => {
    const rows = byFile[file] || [];
    const counted = rows.slice(skip);
    return {
      total: {
        input: counted.reduce((a, r) => a + r[0], 0),
        cacheRead: counted.reduce((a, r) => a + r[1], 0),
        cacheCreation: 0,
        output: counted.reduce((a, r) => a + r[2], 0),
        msgs: counted.length,
      },
      usageMsgs: rows.length,
    };
  };
}

test('ledger: first scan counts everything, cursor advances', () => {
  ledger.reset();
  const txs = [{ file: 'f1' }, { file: 'f2' }];
  const r1 = ledger.update(txs, fakeParse({ f1: [[100, 0, 10], [200, 0, 20]], f2: [[300, 0, 30]] }));
  assert.strictEqual(r1.totals.input, 600);
  assert.strictEqual(r1.totals.output, 60);

  // Second scan: f1 grew by one row, f2 unchanged → only f1 increment added.
  const r2 = ledger.update(txs, fakeParse({ f1: [[100, 0, 10], [200, 0, 20], [50, 0, 5]], f2: [[300, 0, 30]] }));
  assert.strictEqual(r2.totals.input, 650);
  assert.strictEqual(r2.totals.output, 65);
});

test('ledger: file disappearing does NOT decrease totals', () => {
  ledger.reset();
  ledger.update([{ file: 'big' }, { file: 'small' }], fakeParse({ big: [[1000, 0, 100]], small: [[10, 0, 1]] }));
  const r2 = ledger.update([{ file: 'big' }], fakeParse({ big: [[1000, 0, 100]] }));
  assert.strictEqual(r2.totals.input, 1010, 'totals stay at previous cumulative');
  assert.strictEqual(r2.totals.output, 101);
});

test('ledger: shrunk file (compact) does not decrease, resumes on regrowth', () => {
  ledger.reset();
  ledger.update([{ file: 'f' }], fakeParse({ f: [[10, 0, 1], [20, 0, 2]] }));   // input 30
  // compact rewrites: file now has only 1 row
  const r2 = ledger.update([{ file: 'f' }], fakeParse({ f: [[10, 0, 1]] }));
  assert.strictEqual(r2.totals.input, 30, 'no decrease on shrink');
  // grows past cursor again → new rows counted
  const r3 = ledger.update([{ file: 'f' }], fakeParse({ f: [[10, 0, 1], [20, 0, 2], [30, 0, 3]] }));
  // 80 = 30 (kept) + 50 (rows 2-3 after cursor fell back to 1 on compact).
  // Slight overcount after a compact is the accepted cost of monotonicity
  // (never undercount).
  assert.strictEqual(r3.totals.input, 80, 'regrowth adds increments');
});

test('ledger: persistence across load()', () => {
  ledger.reset();
  ledger.update([{ file: 'f' }], fakeParse({ f: [[42, 0, 4]] }));
  const loaded = ledger.load();
  assert.strictEqual(loaded.totals.input, 42);
  assert.strictEqual(loaded.byFile.f.usageMsgs, 1);
  ledger.reset();
});

// ── Sprint 42: rebuildBaseline ───────────────────────────────────────────

test('ledger: rebuildBaseline counts everything from scratch', () => {
  ledger.reset();
  // First, build up some incremental state.
  const txs = [{ file: 'a' }, { file: 'b' }];
  ledger.update(txs, fakeParse({ a: [[100, 0, 10]], b: [[200, 0, 20]] }));
  // Simulate deleted transcript: file 'b' is gone, but cursor still has it.
  // rebuildBaseline should only count what's actually on disk NOW.
  const result = ledger.rebuildBaseline(
    [{ file: 'a' }, { file: 'c' }],
    fakeParse({ a: [[100, 0, 10], [50, 0, 5]], c: [[300, 0, 30]] }),
  );
  // a: 150input + c: 300input = 450 (b's 200 is NOT included — it's gone)
  assert.strictEqual(result.totals.input, 450, 'only counts current files');
  assert.strictEqual(result.totals.output, 45);
  assert.ok(result.byFile.a);
  assert.ok(result.byFile.c);
  assert.strictEqual(result.byFile.b, undefined, 'deleted file not in byFile');
});

test('ledger: rebuildBaseline resets the cursor', () => {
  ledger.reset();
  const txs = [{ file: 'x' }];
  // Incremental update builds cursor.
  const r1 = ledger.update(txs, fakeParse({ x: [[10, 0, 1]] }));
  assert.strictEqual(r1.totals.input, 10);
  // Rebuild from the SAME files — totals should now equal the rebuild count,
  // NOT the old cumulative + the increment.
  const r2 = ledger.rebuildBaseline(txs, fakeParse({ x: [[10, 0, 1], [20, 0, 2]] }));
  assert.strictEqual(r2.totals.input, 30, 'rebuild is exact current-total, not cumulative + delta');
  assert.strictEqual(r2.totals.output, 3);
});

test('ledger: rebuildBaseline with empty transcripts returns zeroed totals', () => {
  ledger.reset();
  // Seed some state first.
  ledger.update([{ file: 'old' }], fakeParse({ old: [[1000, 0, 100]] }));
  // Rebuild with no files → should be all zeros.
  const result = ledger.rebuildBaseline([], fakeParse({}));
  assert.strictEqual(result.totals.input, 0);
  assert.strictEqual(result.totals.output, 0);
  assert.deepStrictEqual(result.byFile, {});
});

test('ledger: rebuildBaseline persists (loadable after rebuild)', () => {
  ledger.reset();
  ledger.rebuildBaseline(
    [{ file: 'f' }],
    fakeParse({ f: [[77, 0, 7]] }),
  );
  const loaded = ledger.load();
  assert.strictEqual(loaded.totals.input, 77);
  assert.strictEqual(loaded.totals.output, 7);
  assert.strictEqual(loaded.byFile.f.usageMsgs, 1);
  ledger.reset();
});

test('ledger: rebuildBaseline handles unreadable files gracefully', () => {
  ledger.reset();
  // File that throws on read — should be skipped without crashing.
  const badParse = (file, skip) => {
    if (file === 'bad') throw new Error('ENOENT');
    return { total: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1, msgs: 1 }, usageMsgs: 1 };
  };
  const result = ledger.rebuildBaseline(
    [{ file: 'bad' }, { file: 'good' }],
    badParse,
  );
  assert.strictEqual(result.totals.input, 10, 'bad file skipped, good counted');
  assert.strictEqual(result.byFile.bad, undefined);
});
