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
