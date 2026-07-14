'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Reload module for each test to get a clean state.
beforeEach(() => {
  delete require.cache[require.resolve('../lib/agentBus/taskAnalytics')];
});

function setup() {
  return require('../lib/agentBus/taskAnalytics');
}

describe('taskAnalytics — track (#73)', () => {
  test('track records capabilities', () => {
    const a = setup();
    a.track(['frontend', 'react']);
    const stats = a.getStats();
    assert.equal(stats.totalTracked, 1);
  });

  test('track ignores empty capabilities', () => {
    const a = setup();
    a.track([]);
    a.track(null);
    a.track(undefined);
    assert.equal(a.getStats().totalTracked, 0);
  });

  test('getHotCapabilities returns sorted counts', () => {
    const a = setup();
    a.track(['frontend']);
    a.track(['frontend', 'react']);
    a.track(['react']);

    const hot = a.getHotCapabilities(1);
    assert.equal(hot.length, 2);
    // frontend should be first (2), then react (2)
    assert.equal(hot[0].capability, 'frontend');
    assert.equal(hot[0].count, 2);
    assert.equal(hot[1].capability, 'react');
    assert.equal(hot[1].count, 2);
  });

  test('getHotCapabilities respects minCount filter', () => {
    const a = setup();
    a.track(['frontend']);
    a.track(['react']);
    a.track(['react']);

    const hot = a.getHotCapabilities(2);
    assert.equal(hot.length, 1);
    assert.equal(hot[0].capability, 'react');
    assert.equal(hot[0].count, 2);
  });
});

describe('taskAnalytics — recruitment threshold (#73)', () => {
  test('emits recruitment_suggested when threshold reached', () => {
    const a = setup();
    const emitted = [];
    a.analyticsEvents.on('recruitment_suggested', (e) => emitted.push(e));

    // THRESHOLD = 5 (from taskAnalytics.js)
    for (let i = 0; i < 5; i++) {
      a.track(['testing']);
    }

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].capability, 'testing');
    assert.equal(emitted[0].count, 5);

    a.analyticsEvents.removeAllListeners();
  });

  test('no emit below threshold', () => {
    const a = setup();
    const emitted = [];
    a.analyticsEvents.on('recruitment_suggested', (e) => emitted.push(e));

    for (let i = 0; i < 4; i++) {
      a.track(['testing']);
    }

    assert.equal(emitted.length, 0);
    a.analyticsEvents.removeAllListeners();
  });

  test('only emits once per capability', () => {
    const a = setup();
    const emitted = [];
    a.analyticsEvents.on('recruitment_suggested', (e) => emitted.push(e));

    for (let i = 0; i < 10; i++) {
      a.track(['testing']);
    }

    assert.equal(emitted.length, 1, 'should only emit once per capability');
    a.analyticsEvents.removeAllListeners();
  });

  test('getStats reports alerted capabilities', () => {
    const a = setup();
    for (let i = 0; i < 5; i++) a.track(['security']);

    const stats = a.getStats();
    assert.ok(stats.alertedCapabilities.includes('security'));
    assert.equal(stats.threshold, 5);
  });
});

describe('taskAnalytics — onTaskSent (#73)', () => {
  test('onTaskSent tracks required_capabilities', () => {
    const a = setup();
    a.onTaskSent({ required_capabilities: ['backend', 'node'] });
    a.onTaskSent({ required_capabilities: ['backend'] });

    const hot = a.getHotCapabilities(1);
    const backend = hot.find((h) => h.capability === 'backend');
    assert.equal(backend.count, 2);
  });

  test('onTaskSent handles task without required_capabilities', () => {
    const a = setup();
    a.onTaskSent({ content: 'hello' });
    a.onTaskSent({});
    assert.equal(a.getStats().totalTracked, 0);
  });
});
