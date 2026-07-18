'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const tmpBase = path.join(os.tmpdir(), 'boos-atomic-' + Date.now().toString(36));

beforeEach(async () => {
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
});

const { atomicWriteJson, withFileLock } = require('../lib/atomicJson');

// ── atomicWriteJson basics ─────────────────────────────────────────

describe('atomicWriteJson', () => {
  test('writes JSON and reads it back correctly', async () => {
    const filePath = path.join(tmpBase, 'test.json');
    const data = { hello: 'world', count: 42, nested: { x: true } };
    await atomicWriteJson(filePath, data);
    const raw = await fsp.readFile(filePath, 'utf8');
    assert.deepEqual(JSON.parse(raw), data);
  });

  test('overwrites file atomically', async () => {
    const filePath = path.join(tmpBase, 'overwrite.json');
    await atomicWriteJson(filePath, { version: 1, payload: 'A'.repeat(100) });
    await atomicWriteJson(filePath, { version: 2, payload: 'B'.repeat(100) });
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.payload, 'B'.repeat(100));
  });

  test('handles large JSON objects without corruption', async () => {
    const filePath = path.join(tmpBase, 'large.json');
    const largeArray = Array.from({ length: 50000 }, (_, i) => ({
      index: i,
      name: 'item-' + i,
      data: 'x'.repeat(100),
    }));
    await atomicWriteJson(filePath, largeArray);
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 50000);
    assert.equal(parsed[0].index, 0);
    assert.equal(parsed[49999].index, 49999);
  });

  test('cleans up tmp file after successful write', async () => {
    const filePath = path.join(tmpBase, 'notmp.json');
    await atomicWriteJson(filePath, { clean: true });
    const dir = await fsp.readdir(tmpBase);
    const tmpFiles = dir.filter((f) => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });

  test('handles special characters in JSON', async () => {
    const filePath = path.join(tmpBase, 'special.json');
    const data = {
      unicode: '你好世界 🚀',
      quotes: 'he said "hello"',
      slash: 'a/b\\c',
      newlines: 'line1\nline2\r\nline3',
    };
    await atomicWriteJson(filePath, data);
    const raw = await fsp.readFile(filePath, 'utf8');
    assert.deepEqual(JSON.parse(raw), data);
  });
});

// ── withFileLock ────────────────────────────────────────────────────

describe('withFileLock', () => {
  test('serializes concurrent writes - no lost updates', async () => {
    const filePath = path.join(tmpBase, 'concurrent.json');
    await atomicWriteJson(filePath, { counter: 0 });
    const increments = 50;
    const writers = Array.from({ length: increments }, () =>
      withFileLock(filePath, async () => {
        let current;
        try { const raw = await fsp.readFile(filePath, 'utf8'); current = JSON.parse(raw); }
        catch { current = { counter: 0 }; }
        current.counter += 1;
        await atomicWriteJson(filePath, current);
        return current.counter;
      })
    );
    const results = await Promise.all(writers);
    const uniqueCounters = new Set(results);
    assert.equal(uniqueCounters.size, increments);
    const final = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    assert.equal(final.counter, increments);
  });

  test('failed mutator does not block subsequent callers', async () => {
    const filePath = path.join(tmpBase, 'poison.json');
    await atomicWriteJson(filePath, { value: 'initial' });
    const badCall = withFileLock(filePath, async () => { throw new Error('simulated failure'); });
    await assert.rejects(() => badCall, /simulated failure/);
    await withFileLock(filePath, async () => {
      const raw = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      data.value = 'after-failure';
      await atomicWriteJson(filePath, data);
    });
    const final = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    assert.equal(final.value, 'after-failure');
  });

  test('locks are per-path - different files do not block each other', async () => {
    const fileA = path.join(tmpBase, 'a.json');
    const fileB = path.join(tmpBase, 'b.json');
    await atomicWriteJson(fileA, { v: 0 });
    await atomicWriteJson(fileB, { v: 0 });
    const start = Date.now();
    const [resultA, resultB] = await Promise.all([
      withFileLock(fileA, async () => { await new Promise((r) => setTimeout(r, 100)); return 'a-done'; }),
      withFileLock(fileB, async () => { await new Promise((r) => setTimeout(r, 100)); return 'b-done'; }),
    ]);
    const elapsed = Date.now() - start;
    assert.equal(resultA, 'a-done');
    assert.equal(resultB, 'b-done');
    assert.ok(elapsed < 180, 'expected <180ms, got ' + elapsed);
  });

  // Sprint 18: timeout starts when fn() begins executing, not when
  // withFileLock is called.  Queue-wait time is unbounded — only the
  // actual fn() wall-clock time counts against the deadline.
  test('withFileLock timeout rejects when fn itself exceeds timeoutMs', async () => {
    const filePath = path.join(tmpBase, 'timeout-fn.json');
    await atomicWriteJson(filePath, { v: 0 });
    // fn takes 300ms > 100ms timeout → must reject.
    await assert.rejects(
      () => withFileLock(filePath, async () => {
        await new Promise((r) => setTimeout(r, 300));
      }, 100),
      /timeout after 100ms/,
    );
  });

  test('withFileLock timeout does NOT count queue-wait time', async () => {
    const filePath = path.join(tmpBase, 'timeout-queue.json');
    await atomicWriteJson(filePath, { v: 0 });
    // Hold the lock for 800ms.
    const holdLock = withFileLock(filePath, async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    await new Promise((r) => setTimeout(r, 50));
    // Second caller has a 200ms timeout but fn is instant.
    // Queue-wait (750ms) must NOT count against the 200ms budget.
    const second = await withFileLock(filePath, async () => 'queued-but-ok', 200);
    assert.equal(second, 'queued-but-ok');
    await holdLock;
  });

  // #51: timeout disabled
  test('withFileLock timeoutMs=0 disables timeout', async () => {
    const filePath = path.join(tmpBase, 'no-timeout.json');
    await atomicWriteJson(filePath, { v: 0 });
    const holdLock = withFileLock(filePath, async () => { await new Promise((r) => setTimeout(r, 300)); return 'held'; });
    await new Promise((r) => setTimeout(r, 50));
    const result = await withFileLock(filePath, async () => 'acquired', 0);
    assert.equal(result, 'acquired');
    await holdLock;
  });
});

// ── #51 regression: cross-process lock, .bak, .lock cleanup ─────────

describe('atomicWriteJson - #51 regression', () => {
  test('creates .bak backup file on successful write', async () => {
    const filePath = path.join(tmpBase, 'with-bak.json');
    await atomicWriteJson(filePath, { first: true });
    await atomicWriteJson(filePath, { second: true });
    const raw = await fsp.readFile(filePath + '.bak', 'utf8');
    assert.deepEqual(JSON.parse(raw), { first: true });
  });

  test('.lock file is cleaned up after write completes', async () => {
    const filePath = path.join(tmpBase, 'lock-cleanup.json');
    await atomicWriteJson(filePath, { clean: true });
    try { await fsp.access(filePath + '.lock'); assert.fail('.lock should not exist'); }
    catch (e) { assert.equal(e.code, 'ENOENT'); }
  });

  test('.bak exists on overwrite, .lock released after write', async () => {
    const filePath = path.join(tmpBase, 'same-dir.json');
    await atomicWriteJson(filePath, { v1: 1 });
    await atomicWriteJson(filePath, { v2: 2 });
    const after = await fsp.readdir(tmpBase);
    assert.ok(after.includes('same-dir.json'));
    assert.ok(after.includes('same-dir.json.bak'), '.bak must exist after overwrite');
    assert.ok(!after.includes('same-dir.json.lock'), '.lock must be released');
  });
});
