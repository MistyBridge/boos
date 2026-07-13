'use strict';

// config.js resolves DATA_DIR from BOOS_HOME at require time.
// Isolate with a temp dir and purge require cache.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpBase = path.join(os.tmpdir(), 'boos-config-' + Date.now().toString(36));
fs.mkdirSync(tmpBase, { recursive: true });
process.env.BOOS_HOME = tmpBase;

// Purge cached lib modules to pick up new BOOS_HOME
for (const key of Object.keys(require.cache)) {
  if (key.includes('boos\\lib\\')) delete require.cache[key];
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');

describe('config · DATA_DIR', () => {
  test('DATA_DIR is set from BOOS_HOME', () => {
    assert.equal(config.DATA_DIR, tmpBase);
  });

  test('CONFIG_PATH is under DATA_DIR', () => {
    assert.equal(config.CONFIG_PATH, path.join(tmpBase, 'config.json'));
  });
});

describe('config · DEFAULTS', () => {
  test('DEFAULTS has required keys', () => {
    const d = config.DEFAULTS;
    assert.equal(typeof d.port, 'number');
    assert.ok(Array.isArray(d.clis));
    assert.ok(Array.isArray(d.repos));
    assert.equal(typeof d.resumeMode, 'string');
    assert.equal(typeof d.editor, 'string');
    assert.equal(typeof d.defaultCliId, 'string');
    assert.ok(d.defaultCliId.length > 0);
  });

  test('DEFAULT_CLIS includes claude, codex, copilot', () => {
    const ids = config.DEFAULT_CLIS.map((c) => c.id);
    assert.deepEqual(ids, ['claude', 'codex', 'copilot']);
  });

  test('builtin CLIs have required templates', () => {
    for (const cli of config.DEFAULT_CLIS) {
      assert.ok(cli.builtin);
      assert.ok(Array.isArray(cli.resumeLatestArgs));
      assert.ok(Array.isArray(cli.resumePickerArgs));
      assert.ok(Array.isArray(cli.resumeIdArgs));
      assert.ok(['direct', 'pwsh', 'cmd'].includes(cli.shell));
    }
  });
});

describe('config · loadConfig + saveConfig', () => {
  test('loadConfig() returns defaults when no config file exists', async () => {
    // Remove config.json to get fresh defaults
    try { await require('node:fs/promises').unlink(config.CONFIG_PATH); } catch {}

    const cfg = await config.loadConfig();
    assert.equal(typeof cfg.port, 'number');
    assert.ok(Array.isArray(cfg.clis));
    assert.ok(cfg.clis.length >= 3); // builtins always injected
  });

  test('loadConfig() returns builtin CLIs even when config is empty', async () => {
    const cfg = await config.loadConfig();
    const ids = cfg.clis.map((c) => c.id);
    assert.ok(ids.includes('claude'));
    assert.ok(ids.includes('codex'));
    assert.ok(ids.includes('copilot'));
  });

  test('saveConfig() persists changes', async () => {
    const before = await config.loadConfig();
    const updated = await config.saveConfig({ port: 9999 });
    assert.equal(updated.port, 9999);

    // Reload should reflect changes
    const reloaded = await config.loadConfig();
    assert.equal(reloaded.port, 9999);

    // Restore
    await config.saveConfig({ port: before.port });
  });

  test('defaultCliId falls back to first CLI when missing', async () => {
    const cfg = await config.loadConfig();
    assert.equal(cfg.defaultCliId, cfg.clis[0].id);
  });

  test('resumeMode clamps to latest or picker', async () => {
    const saved = await config.saveConfig({ resumeMode: 'picker' });
    assert.equal(saved.resumeMode, 'picker');

    const saved2 = await config.saveConfig({ resumeMode: 'bogus' });
    assert.equal(saved2.resumeMode, 'latest');
  });
});
