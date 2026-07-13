'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('cliActivity', () => {
  const { probeActivity, noteOutput, releaseSession } = require('../lib/cliActivity');

  test('probeActivity() returns idle for unknown session', async () => {
    const result = await probeActivity({ id: 'unknown-session' });
    assert.equal(result, 'idle');
  });

  test('noteOutput() then probeActivity() returns working', async () => {
    const id = 'test-sess-active';
    noteOutput(id);
    const result = await probeActivity({ id });
    assert.equal(result, 'working');
    releaseSession(id);
  });

  test('probeActivity() returns idle after release', async () => {
    const id = 'test-sess-released';
    noteOutput(id);
    const before = await probeActivity({ id });
    assert.equal(before, 'working');

    releaseSession(id);
    // After release, it's a "new" session → idle
    const after = await probeActivity({ id });
    assert.equal(after, 'idle');
  });

  test('multiple sessions tracked independently', async () => {
    const idA = 'multi-a';
    const idB = 'multi-b';

    noteOutput(idA);
    // idB is untouched

    const resultA = await probeActivity({ id: idA });
    const resultB = await probeActivity({ id: idB });

    assert.equal(resultA, 'working');
    assert.equal(resultB, 'idle');

    releaseSession(idA);
    releaseSession(idB);
  });

  test('noteOutput() idempotent on repeated calls', async () => {
    const id = 'repeated-calls';
    noteOutput(id);
    noteOutput(id);
    noteOutput(id);
    const result = await probeActivity({ id });
    assert.equal(result, 'working');
    releaseSession(id);
  });
});
