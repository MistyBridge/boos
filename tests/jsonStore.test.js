'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

// Use a temp directory for isolated test runs
const tmpBase = path.join(os.tmpdir(), 'boos-test-' + Date.now().toString(36));

beforeEach(async () => {
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
});

// Helper: create a fresh store instance for each test
function makeStore({ filename = 'test-store.json', transformValue } = {}) {
  const { createKeyedJsonStore } = require('../lib/jsonStore');
  return createKeyedJsonStore({
    dataDir: tmpBase,
    filename,
    transformValue,
  });
}

describe('jsonStore', () => {
  // #1 — load() returns empty object when file doesn't exist
  test('load() returns {} for missing file', async () => {
    const store = makeStore({ filename: 'nonexistent.json' });
    const data = await store.load();
    assert.deepEqual(data, {});
  });

  // #2 — set() + load() round-trip
  test('set() stores a value, load() returns it', async () => {
    const store = makeStore();
    await store.set('key1', { name: 'test', count: 42 });
    const data = await store.load();
    assert.deepEqual(data, { key1: { name: 'test', count: 42 } });
  });

  // #3 — set() overwrites existing key
  test('set() overwrites existing key', async () => {
    const store = makeStore();
    await store.set('key1', { v: 1 });
    await store.set('key1', { v: 2 });
    const data = await store.load();
    assert.deepEqual(data, { key1: { v: 2 } });
  });

  // #4 — set() with null/undefined value triggers remove
  test('set() with null removes the key', async () => {
    const store = makeStore({
      transformValue: (v) => v,
    });
    await store.set('key1', { v: 1 });
    await store.set('key1', null);
    const data = await store.load();
    assert.deepEqual(data, {});
  });

  // #5 — remove() deletes an existing key, returns true
  test('remove() deletes key and returns true', async () => {
    const store = makeStore();
    await store.set('key1', { v: 1 });
    const result = await store.remove('key1');
    assert.equal(result, true);
    const data = await store.load();
    assert.deepEqual(data, {});
  });

  // #6 — remove() on nonexistent key returns false
  test('remove() returns false for missing key', async () => {
    const store = makeStore();
    const result = await store.remove('no-such-key');
    assert.equal(result, false);
  });

  // #7 — list() returns all values
  test('list() returns all stored values', async () => {
    const store = makeStore();
    await store.set('a', { x: 1 });
    await store.set('b', { x: 2 });
    const values = await store.list();
    assert.equal(values.length, 2);
    const xs = values.map((v) => v.x).sort();
    assert.deepEqual(xs, [1, 2]);
  });

  // #8 — list() returns empty array for empty store
  test('list() returns empty array for empty store', async () => {
    const store = makeStore();
    const values = await store.list();
    assert.deepEqual(values, []);
  });

  // #9 — set() throws on empty key
  test('set() throws on empty key', async () => {
    const store = makeStore();
    await assert.rejects(
      () => store.set('', { v: 1 }),
      /key required/
    );
  });

  // #10 — transformValue is applied on set
  test('set() applies transformValue', async () => {
    const store = makeStore({
      transformValue: (v) => ({ ...v, transformed: true }),
    });
    await store.set('key1', { name: 'original' });
    const data = await store.load();
    assert.equal(data.key1.name, 'original');
    assert.equal(data.key1.transformed, true);
  });

  // #11 — concurrent set() calls do not corrupt data
  test('concurrent set() calls preserve all keys', async () => {
    const store = makeStore();
    const keys = Array.from({ length: 20 }, (_, i) => `key${i}`);
    await Promise.all(
      keys.map((k) => store.set(k, { idx: k }))
    );
    const data = await store.load();
    assert.equal(Object.keys(data).length, 20);
    for (const k of keys) {
      assert.ok(data[k], `missing key: ${k}`);
      assert.equal(data[k].idx, k);
    }
  });

  // #12 — set() persists across store instances (disk round-trip)
  test('data persists across store instances', async () => {
    const store1 = makeStore();
    await store1.set('persist', { hello: 'world' });

    const store2 = makeStore();
    const data = await store2.load();
    assert.deepEqual(data, { persist: { hello: 'world' } });
  });
});
