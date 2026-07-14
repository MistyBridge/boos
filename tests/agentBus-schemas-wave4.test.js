'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../lib/agentBus/schemas');

describe('Agent-Bus Wave 4 (#63, #64)', () => {
  test('#64 wake_agent has context parameter', () => {
    const wake = TOOLS.find(t => t.name === 'wake_agent');
    assert.ok(wake, 'wake_agent not found');
    const ctx = wake.inputSchema.properties.context;
    assert.ok(ctx, 'context property missing');
    assert.equal(ctx.type, 'string');
  });

  test('#64 wake_all tool exists with correct schema', () => {
    const wa = TOOLS.find(t => t.name === 'wake_all');
    assert.ok(wa, 'wake_all not found');
    assert.ok(wa.description.includes('supervisor'));
    const p = wa.inputSchema.properties;
    assert.ok(p.message);
    assert.ok(p.urgency);
    assert.deepEqual(p.urgency.enum, ['normal', 'urgent']);
    assert.ok(p.exclude_self);
    assert.equal(p.exclude_self.default, true);
  });

  test('#63 tool count includes wake_all', () => {
    assert.ok(TOOLS.length >= 23, 'expected >=23 tools with wake_all, got ' + TOOLS.length);
  });

  test('#63 workflowEngine onStageCompleted is exported', () => {
    const wf = require('../lib/workflowEngine');
    assert.equal(typeof wf.onStageCompleted, 'function', 'onStageCompleted must be exported for chain trigger');
  });
});
