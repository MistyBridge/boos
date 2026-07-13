'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('winPath', () => {
  const winPath = require('../lib/winPath');

  afterEach(() => {
    // Reset cache between tests
    delete require.cache[require.resolve('../lib/winPath')];
  });

  test('mergedUserPath() returns a string', () => {
    const { mergedUserPath } = require('../lib/winPath');
    const result = mergedUserPath();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  test('mergedUserPath() is idempotent (cached)', () => {
    const { mergedUserPath } = require('../lib/winPath');
    const first = mergedUserPath();
    const second = mergedUserPath();
    assert.equal(first, second); // Same instance from cache
  });

  test('spawnEnv() returns an object with PATH', () => {
    const { spawnEnv } = require('../lib/winPath');
    const env = spawnEnv();
    assert.ok(typeof env === 'object');
    assert.ok('PATH' in env);
  });

  test('spawnEnv() includes extra vars', () => {
    const { spawnEnv } = require('../lib/winPath');
    const env = spawnEnv({ MY_CUSTOM: 'hello', BOOS_TEST: '1' });
    assert.equal(env.MY_CUSTOM, 'hello');
    assert.equal(env.BOOS_TEST, '1');
  });

  test('spawnEnv() preserves existing env vars', () => {
    const { spawnEnv } = require('../lib/winPath');
    const env = spawnEnv();
    assert.ok('SystemRoot' in env || 'SYSTEMROOT' in env || process.platform !== 'win32');
    assert.ok('TEMP' in env || 'TMP' in env || process.platform !== 'win32');
  });

  test('spawnEnv() strips all PATH case variants on Windows', () => {
    const { spawnEnv } = require('../lib/winPath');
    const env = spawnEnv({ Path: 'C:\\fake', pAth: 'C:\\fake2' });
    // Only one PATH should exist (the merged one)
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
    if (process.platform === 'win32') {
      assert.equal(pathKeys.length, 1);
      assert.equal(pathKeys[0], 'PATH');
    }
  });

  test('spawnEnv() extra vars override process.env', () => {
    const { spawnEnv } = require('../lib/winPath');
    const env = spawnEnv({ BOOS_TEST_OVERRIDE: 'overridden' });
    assert.equal(env.BOOS_TEST_OVERRIDE, 'overridden');
  });

  test('buildMergedUserPath() returns string on all platforms', () => {
    const { buildMergedUserPath } = require('../lib/winPath');
    const result = buildMergedUserPath();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});
