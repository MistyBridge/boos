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

describe('atomicWriteJson', () => {
  // #1 — basic write + read round-trip
  test('writes JSON and reads it back correctly', async () => {
    const filePath = path.join(tmpBase, 'test.json');
    const data = { hello: 'world', count: 42, nested: { x: true } };

    await atomicWriteJson(filePath, data);
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    assert.deepEqual(parsed, data);
  });

  // #2 — write overwrites existing file atomically (no partial reads)
  test('overwrites file atomically — readers see complete old or new data', async () => {
    const filePath = path.join(tmpBase, 'overwrite.json');

    // Write initial data
    await atomicWriteJson(filePath, { version: 1, payload: 'A'.repeat(100) });

    // Write new data
    await atomicWriteJson(filePath, { version: 2, payload: 'B'.repeat(100) });

    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Must be complete new data, not a mix
    assert.equal(parsed.version, 2);
    assert.equal(parsed.payload, 'B'.repeat(100));
  });

  // #3 — write handles large objects (10MB+)
  test('handles large JSON objects without corruption', async () => {
    const filePath = path.join(tmpBase, 'large.json');
    const largeArray = Array.from({ length: 50000 }, (_, i) => ({
      index: i,
      name: `item-${i}`,
      data: 'x'.repeat(100),
    }));

    await atomicWriteJson(filePath, largeArray);
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    assert.equal(parsed.length, 50000);
    assert.equal(parsed[0].index, 0);
    assert.equal(parsed[49999].index, 49999);
  });

  // #4 — no leftover tmp files after successful write
  test('cleans up tmp file after successful write', async () => {
    const filePath = path.join(tmpBase, 'notmp.json');
    await atomicWriteJson(filePath, { clean: true });

    const dir = await fsp.readdir(tmpBase);
    const tmpFiles = dir.filter((f) => f.endsWith('.json') && f !== 'notmp.json');
    assert.equal(tmpFiles.length, 0, `leftover tmp files: ${tmpFiles.join(', ')}`);
  });

  // #5 — write with special characters
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
    const parsed = JSON.parse(raw);

    assert.deepEqual(parsed, data);
  });
});

describe('withFileLock', () => {
  // #6 — serializes write operations (concurrent safety)
  test('serializes concurrent writes — no lost updates', async () => {
    const filePath = path.join(tmpBase, 'concurrent.json');

    // Initialize with a counter
    await atomicWriteJson(filePath, { counter: 0 });

    const increments = 50;

    // Each "writer" reads, increments, and writes
    const writers = Array.from({ length: increments }, () =>
      withFileLock(filePath, async () => {
        let current;
        try {
          const raw = await fsp.readFile(filePath, 'utf8');
          current = JSON.parse(raw);
        } catch {
          current = { counter: 0 };
        }
        current.counter += 1;
        await atomicWriteJson(filePath, current);
        return current.counter;
      })
    );

    const results = await Promise.all(writers);

    // Every writer should see a unique counter value
    // (no two writers saw the same intermediate state)
    const uniqueCounters = new Set(results);
    assert.equal(uniqueCounters.size, increments, 'some writers saw duplicate counter values');

    // Final counter should equal the number of increments
    const raw = await fsp.readFile(filePath, 'utf8');
    const final = JSON.parse(raw);
    assert.equal(final.counter, increments);
  });

  // #7 — a failed mutator does not poison the lock chain
  test('failed mutator does not block subsequent callers', async () => {
    const filePath = path.join(tmpBase, 'poison.json');
    await atomicWriteJson(filePath, { value: 'initial' });

    // First mutator throws
    const badCall = withFileLock(filePath, async () => {
      throw new Error('simulated failure');
    });
    await assert.rejects(() => badCall, /simulated failure/);

    // Second mutator should still work
    await withFileLock(filePath, async () => {
      const raw = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      data.value = 'after-failure';
      await atomicWriteJson(filePath, data);
    });

    const raw = await fsp.readFile(filePath, 'utf8');
    const final = JSON.parse(raw);
    assert.equal(final.value, 'after-failure');
  });

  // #8 — lock is per-path isolated
  test('locks are per-path — different files do not block each other', async () => {
    const fileA = path.join(tmpBase, 'a.json');
    const fileB = path.join(tmpBase, 'b.json');
    await atomicWriteJson(fileA, { v: 0 });
    await atomicWriteJson(fileB, { v: 0 });

    const start = Date.now();

    // Two slow writes on different files run concurrently
    const [resultA, resultB] = await Promise.all([
      withFileLock(fileA, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'a-done';
      }),
      withFileLock(fileB, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'b-done';
      }),
    ]);

    const elapsed = Date.now() - start;

    assert.equal(resultA, 'a-done');
    assert.equal(resultB, 'b-done');
    // Different files = no lock contention → should finish in ~100ms, not ~200ms
    assert.ok(elapsed < 180, `expected concurrent execution (<180ms), got ${elapsed}ms`);
  });
});
