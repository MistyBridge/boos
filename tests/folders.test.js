'use strict';

// folders.js depends on config.js DATA_DIR via process.env.BOOS_HOME.
// Set a temp dir before requiring to isolate from real ~/.boos/folders.json.
// Purge require cache so this works alongside other test files.
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');

const tmpBase = path.join(os.tmpdir(), 'boos-folders-' + Date.now().toString(36));
require('node:fs').mkdirSync(tmpBase, { recursive: true });
process.env.BOOS_HOME = tmpBase;

for (const key of Object.keys(require.cache)) {
  if (key.includes('boos\\lib\\')) delete require.cache[key];
}

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const folders = require('../lib/folders');

afterEach(async () => {
  try { await fsp.unlink(folders.FILE); } catch {}
});

describe('folders', () => {
  test('loadAll() returns Unsorted folder by default', async () => {
    const list = await folders.loadAll();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'unsorted');
    assert.equal(list[0].name, 'Unsorted');
    assert.equal(list[0].builtin, true);
  });

  test('create() adds a new folder', async () => {
    const entry = await folders.create({ name: 'My Projects' });
    assert.ok(entry.id.startsWith('folder-'));
    assert.equal(entry.name, 'My Projects');
    assert.ok(typeof entry.order === 'number');

    const list = await folders.loadAll();
    assert.ok(list.find((f) => f.id === entry.id));
  });

  test('create() throws on empty name', async () => {
    await assert.rejects(() => folders.create({ name: '' }), /name required/);
  });

  test('update() renames a folder', async () => {
    const entry = await folders.create({ name: 'Old Name' });
    const updated = await folders.update(entry.id, { name: 'New Name' });
    assert.equal(updated.name, 'New Name');
  });

  test('update() cannot rename Unsorted', async () => {
    await assert.rejects(
      () => folders.update('unsorted', { name: 'Sorted' }),
      /cannot rename the Unsorted bucket/
    );
  });

  test('update() returns null for nonexistent', async () => {
    const result = await folders.update('no-such', { name: 'x' });
    assert.equal(result, null);
  });

  test('remove() deletes a folder', async () => {
    const entry = await folders.create({ name: 'Delete Me' });
    const result = await folders.remove(entry.id);
    assert.equal(result, true);

    const list = await folders.loadAll();
    assert.equal(list.find((f) => f.id === entry.id), undefined);
  });

  test('remove() cannot delete Unsorted', async () => {
    await assert.rejects(
      () => folders.remove('unsorted'),
      /cannot delete the Unsorted bucket/
    );
  });

  test('remove() returns false for nonexistent', async () => {
    const result = await folders.remove('no-such');
    assert.equal(result, false);
  });

  test('reorder() changes order of folders', async () => {
    const a = await folders.create({ name: 'A' });
    const b = await folders.create({ name: 'B' });
    const c = await folders.create({ name: 'C' });

    // Reverse order: C, B, A
    const ordered = await folders.reorder([c.id, b.id, a.id]);

    assert.equal(ordered.find((f) => f.id === c.id).order, 0);
    assert.equal(ordered.find((f) => f.id === b.id).order, 1);
    assert.equal(ordered.find((f) => f.id === a.id).order, 2);
  });

  test('reorder() preserves folders not in the list', async () => {
    const a = await folders.create({ name: 'A' });
    const b = await folders.create({ name: 'B' });
    await folders.reorder([b.id]); // Only B is in the list

    const list = await folders.loadAll();
    assert.ok(list.find((f) => f.id === a.id)); // A should still exist
    assert.ok(list.find((f) => f.id === b.id));
  });

  test('reorder() throws on non-array input', async () => {
    await assert.rejects(
      () => folders.reorder('not-an-array'),
      /idsInOrder must be array/
    );
  });
});
