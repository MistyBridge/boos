'use strict';

// Unit tests for public/js/util.js — pure functions, no DOM dependencies.
// Run: node --test tests/frontend-util.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline the util.js functions we're testing (pure logic, no framework deps) ──

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return sec + '秒前';
  if (sec < 3600) return Math.floor(sec / 60) + '分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + '小时前';
  return Math.floor(sec / 86400) + '天前';
}

function displayTitle(label, fallback) {
  return label || fallback || '(无标题)';
}

function nowClock() {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

// Shell-style argv tokenizer — mirrors public/js/util.js parseArgs
function parseArgs(input) {
  const s = String(input || '');
  const out = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined)      out.push(m[1]);
    else if (m[2] !== undefined) out.push(m[2].replace(/\\([\\"])/g, '$1'));
    else                         out.push(m[3]);
  }
  return out;
}

function formatArgs(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((a) => {
    const s = String(a ?? '');
    if (s === '') return '""';
    if (/[\s"'\\`$]/.test(s)) {
      return '"' + s.replace(/([\\"])/g, '\\$1') + '"';
    }
    return s;
  }).join(' ');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('fmtTime', () => {
  test('returns dash for falsy input', () => {
    assert.equal(fmtTime(0), '—');
    assert.equal(fmtTime(null), '—');
    assert.equal(fmtTime(undefined), '—');
  });

  test('returns zh-CN formatted string for valid timestamp', () => {
    const result = fmtTime(1700000000000);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Should contain date/time separators (zh-CN format)
    assert.ok(result.includes('/') || result.includes(':'));
  });
});

describe('fmtAgo', () => {
  test('returns dash for falsy input', () => {
    assert.equal(fmtAgo(0), '—');
    assert.equal(fmtAgo(null), '—');
  });

  test('returns seconds for < 60s ago', () => {
    const ms = Date.now() - 30 * 1000;
    const result = fmtAgo(ms);
    assert.ok(result.includes('秒前'));
  });

  test('returns minutes for < 3600s ago', () => {
    const ms = Date.now() - 5 * 60 * 1000;
    const result = fmtAgo(ms);
    assert.ok(result.includes('分钟前'));
  });

  test('returns hours for < 86400s ago', () => {
    const ms = Date.now() - 3 * 3600 * 1000;
    const result = fmtAgo(ms);
    assert.ok(result.includes('小时前'));
  });

  test('returns days for >= 86400s ago', () => {
    const ms = Date.now() - 2 * 86400 * 1000;
    const result = fmtAgo(ms);
    assert.ok(result.includes('天前'));
  });
});

describe('displayTitle', () => {
  test('returns label when provided', () => {
    assert.equal(displayTitle('My Session', 'fallback'), 'My Session');
  });

  test('returns fallback when label is empty', () => {
    assert.equal(displayTitle('', 'fallback-title'), 'fallback-title');
    assert.equal(displayTitle(null, 'fallback-title'), 'fallback-title');
  });

  test('returns (无标题) when both are falsy', () => {
    assert.equal(displayTitle('', ''), '(无标题)');
    assert.equal(displayTitle(null, null), '(无标题)');
  });
});

describe('nowClock', () => {
  test('returns a non-empty time string', () => {
    const result = nowClock();
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    assert.ok(result.includes(':'));
  });

  test('uses 24h format (no AM/PM)', () => {
    const result = nowClock();
    assert.ok(!result.includes('AM'));
    assert.ok(!result.includes('PM'));
  });
});

describe('parseArgs', () => {
  test('splits bare tokens on whitespace', () => {
    assert.deepEqual(parseArgs('-Model --verbose'), ['-Model', '--verbose']);
    assert.deepEqual(parseArgs('a b c'), ['a', 'b', 'c']);
  });

  test('handles double-quoted strings with spaces', () => {
    assert.deepEqual(parseArgs('-Path "C:\\Users\\foo"'), ['-Path', 'C:\\Users\\foo']);
    assert.deepEqual(parseArgs('"hello world" test'), ['hello world', 'test']);
  });

  test('handles escaped quotes inside double-quotes', () => {
    assert.deepEqual(parseArgs('"say \\"hi\\""'), ['say "hi"']);
  });

  test('handles single-quoted strings literally', () => {
    assert.deepEqual(parseArgs("'hello world' test"), ['hello world', 'test']);
  });

  test('handles mixed quoting styles', () => {
    const result = parseArgs('-Foo "x y" \'z\' bare');
    assert.deepEqual(result, ['-Foo', 'x y', 'z', 'bare']);
  });

  test('returns empty array for empty or whitespace-only input', () => {
    assert.deepEqual(parseArgs(''), []);
    assert.deepEqual(parseArgs('   '), []);
    assert.deepEqual(parseArgs(null), []);
  });
});

describe('formatArgs', () => {
  test('round-trips with parseArgs', () => {
    const input = ['-Model', '--verbose', '--resume'];
    const formatted = formatArgs(input);
    const parsed = parseArgs(formatted);
    assert.deepEqual(parsed, input);
  });

  test('quotes tokens with spaces', () => {
    const result = formatArgs(['hello world', 'bare']);
    assert.ok(result.includes('"hello world"'));
    assert.ok(result.includes('bare'));
  });

  test('handles empty string token', () => {
    const result = formatArgs(['']);
    assert.equal(result, '""');
  });

  test('returns empty string for non-array input', () => {
    assert.equal(formatArgs(null), '');
    assert.equal(formatArgs(undefined), '');
    assert.equal(formatArgs('not-array'), '');
  });

  test('escapes double quotes and backslashes', () => {
    const result = formatArgs(['say "hi"', 'C:\\path']);
    assert.ok(result.includes('\\"'));
    assert.ok(result.includes('\\\\'));
  });
});

describe('parseArgs ↔ formatArgs round-trip', () => {
  test('complex argv survives round-trip', () => {
    const testCases = [
      ['claude', '--resume', 'abc-123'],
      ['-Model', 'claude-sonnet-5'],
      ['--verbose', '--dangerously-skip-permissions'],
      ['codex', 'resume', 'session-id-here'],
    ];
    for (const tc of testCases) {
      assert.deepEqual(parseArgs(formatArgs(tc)), tc);
    }
  });
});
