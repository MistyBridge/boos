// Unit tests for lib/agentBus/cacheStore.js — externalized letter content.
//
// Sprint 41: long task content / results / feedback live in per-task cache
// files (one small file per kind), letters carry only a summary + ref.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Point DATA_DIR at a temp dir so cache files don't pollute real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-store-test-'));
process.env.BOOS_HOME = tmp;
const { CACHE_DIR, INLINE_MAX, shapeContent, fullContent, read, del, cachePath } = require('../lib/agentBus/cacheStore');

test('shapeContent: short content stays inline (no ref)', () => {
  const { letter, ref } = shapeContent('task_a', 'short body', 'content');
  assert.strictEqual(letter, 'short body');
  assert.strictEqual(ref, null);
});

test('shapeContent: long content externalized to cache file + ref', () => {
  const long = 'x'.repeat(INLINE_MAX + 100);
  const { letter, ref } = shapeContent('task_long', long, 'content');
  assert.ok(ref, 'cache:content');
  assert.ok(letter.includes('cache/'), 'letter mentions cache path');
  assert.ok(letter.length < INLINE_MAX + 50, 'letter stays short');
  assert.strictEqual(read('task_long', 'content'), long, 'full text round-trips');
});

test('shapeContent: fullContent rehydrates via ref', () => {
  const long = 'y'.repeat(INLINE_MAX + 50);
  const { letter, ref } = shapeContent('task_rehydrate', long, 'result');
  const task = { task_id: 'task_rehydrate', content: letter, content_ref: ref };
  assert.strictEqual(fullContent(task, 'result'), long);
  // Without ref, falls back to inline content.
  const plain = { task_id: 'x', content: 'inline' };
  assert.strictEqual(fullContent(plain), 'inline');
});

test('shapeContent: different kinds write separate files', () => {
  shapeContent('task_multi', 'c'.repeat(INLINE_MAX + 10), 'content');
  shapeContent('task_multi', 'r'.repeat(INLINE_MAX + 10), 'result');
  assert.ok(cachePath('task_multi', 'content').endsWith('task_multi-content.md'));
  assert.ok(cachePath('task_multi', 'result').endsWith('task_multi-result.md'));
  assert.strictEqual(read('task_multi', 'content'), 'c'.repeat(INLINE_MAX + 10));
  assert.strictEqual(read('task_multi', 'result'), 'r'.repeat(INLINE_MAX + 10));
});

test('del: removes all kinds for a task', () => {
  shapeContent('task_del', 'd'.repeat(INLINE_MAX + 10), 'content');
  shapeContent('task_del', 'd'.repeat(INLINE_MAX + 10), 'result');
  assert.ok(fs.existsSync(cachePath('task_del', 'content')));
  del('task_del');
  assert.ok(!fs.existsSync(cachePath('task_del', 'content')));
  assert.ok(!fs.existsSync(cachePath('task_del', 'result')));
});

test('read: missing file returns null', () => {
  assert.strictEqual(read('task_nonexistent', 'content'), null);
});

test('task id sanitization: safe filenames only', () => {
  const p = cachePath('task/../../evil', 'content');
  assert.ok(!p.includes('..'), 'no path traversal');
  assert.ok(p.endsWith('.md'));
});
