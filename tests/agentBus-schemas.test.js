'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS } = require('../lib/agentBus/schemas');

describe('Agent-Bus Tool Schemas', () => {
  test('all 22 tools are defined', () => {
    assert.ok(TOOLS.length >= 22, `expected >=22 tools, got ${TOOLS.length}`);
  });

  test('every tool has name + description + inputSchema', () => {
    for (const t of TOOLS) {
      assert.ok(typeof t.name === 'string' && t.name.length > 0,
        `tool missing name: ${JSON.stringify(t).slice(0, 60)}`);
      assert.ok(typeof t.description === 'string' && t.description.length > 0,
        `${t.name}: missing description`);
      assert.ok(t.inputSchema && typeof t.inputSchema === 'object',
        `${t.name}: missing inputSchema`);
    }
  });

  test('no duplicate tool names', () => {
    const names = TOOLS.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size,
      `duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  test('required tools exist', () => {
    const names = new Set(TOOLS.map(t => t.name));
    const required = [
      'register_agent', 'deregister_agent', 'list_agents',
      'send_task', 'check_inbox', 'cancel_task', 'interrupt_task',
      'respond_task', 'list_my_tasks', 'get_task', 'broadcast',
      'define_workflow', 'add_stage', 'add_dependency', 'activate_workflow',
      'request_decision', 'check_decisions',
      'assign_task', 'list_all_agents', 'kill_worker',
      'boos_terminal_list', 'wake_agent',
    ];
    for (const name of required) {
      assert.ok(names.has(name), `missing tool: ${name}`);
    }
  });

  // Sprint 6: wake_agent tool
  describe('wake_agent', () => {
    const wake = TOOLS.find(t => t.name === 'wake_agent');
    assert.ok(wake, 'wake_agent tool not found');

    test('requires target_uid', () => {
      assert.deepEqual(wake.inputSchema.required, ['target_uid']);
    });

    test('has urgency enum', () => {
      const urgency = wake.inputSchema.properties.urgency;
      assert.ok(urgency, 'urgency property missing');
      assert.deepEqual(urgency.enum, ['normal', 'urgent']);
      assert.equal(urgency.default, 'normal');
    });

    test('has optional message field', () => {
      const msg = wake.inputSchema.properties.message;
      assert.ok(msg, 'message property missing');
      assert.ok(msg.type === 'string', 'message should be string type');
    });
  });

  // Sprint 6: list_agents no longer mentions heartbeat TTL
  test('list_agents description updated (no heartbeat TTL)', () => {
    const la = TOOLS.find(t => t.name === 'list_agents');
    assert.ok(la, 'list_agents not found');
    assert.ok(!la.description.includes('5 minutes'),
      'list_agents should no longer mention 5-minute TTL');
  });
});
