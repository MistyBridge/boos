'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let tmpBase;

beforeEach(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-cloop-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  try { delete require.cache[require.resolve('../lib/config')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/store')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/registry')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/collaborationLoop')]; } catch {}
});

afterEach(() => {
  delete process.env.BOOS_HOME;
  try { delete require.cache[require.resolve('../lib/config')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/store')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/registry')]; } catch {}
  try { delete require.cache[require.resolve('../lib/agentBus/collaborationLoop')]; } catch {}
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

async function setup(registerCount) {
  const cl = require('../lib/agentBus/collaborationLoop');
  const registry = require('../lib/agentBus/registry');
  const store = require('../lib/agentBus/store');

  const agents = [];
  for (let i = 0; i < (registerCount || 3); i++) {
    const r = await registry.registerAgent({
      name: 'Agent-' + i,
      intro: 'Test agent',
      workspace: 'boos',
      role: 'worker',
      capabilities: ['testing'],
    });
    agents.push(r);
  }
  return { cl, registry, store, agents };
}

// ── agent state tracking (#74) ─────────────────────────────────────

describe('collaborationLoop — state tracking (#74)', () => {
  test('getAgentState returns idle for new agent', async () => {
    const { cl, agents } = await setup(1);
    const state = cl.getAgentState(agents[0].uid);
    assert.equal(state.state, 'idle');
    assert.equal(state.taskCount, 0);
  });

  test('collaborationStatus returns ready_for_work', async () => {
    const { cl, agents } = await setup(1);
    const status = cl.collaborationStatus(agents[0].uid);
    assert.equal(status.state, 'idle');
    assert.equal(status.ready_for_work, true);
  });

  test('refreshState updates state', async () => {
    const { cl, agents } = await setup(1);
    const s1 = cl.getAgentState(agents[0].uid);
    const s2 = cl.refreshState(agents[0].uid);
    assert.equal(s1.state, s2.state);
  });
});

// ── agent ranking (#72/#74) ────────────────────────────────────────

describe('collaborationLoop — rankByAvailability (#74)', () => {
  test('rankByAvailability prefers idle agents first', async () => {
    const { cl, agents } = await setup(3);

    const agentData = agents.map((a) => ({
      uid: a.uid,
      name: a.name,
      capabilities: a.capabilities || ['testing'],
    }));

    const ranked = cl.rankByAvailability(agentData, ['testing']);
    assert.equal(ranked.length, 3);
    // All idle initially, then sorted by capability match (all equal score)
    assert.ok(ranked.every((r) => r.isIdle));
  });

  test('rankByAvailability sorts by capScore when same state', async () => {
    const cl = require('../lib/agentBus/collaborationLoop');
    const agents = [
      { uid: 'a1', capabilities: ['frontend', 'react'] },
      { uid: 'a2', capabilities: ['backend'] },
      { uid: 'a3', capabilities: ['frontend', 'react', 'css'] },
    ];

    const ranked = cl.rankByAvailability(agents, ['frontend', 'react']);
    assert.ok(ranked[0].capScore >= ranked[1].capScore);
    assert.ok(ranked[0].capScore >= ranked[2].capScore);
  });
});

// ── findBestAgent (#72) ────────────────────────────────────────────

describe('collaborationLoop — findBestAgent (#72)', () => {
  test('findBestAgent returns best matching agent uid', async () => {
    const { cl, agents } = await setup(3);

    const agentData = agents.map((a) => ({
      uid: a.uid,
      name: a.name,
      capabilities: a.capabilities || ['testing'],
    }));

    const best = cl.findBestAgent(agentData, ['testing'], 'sender-1');
    assert.ok(best);
    assert.ok(agents.some((a) => a.uid === best));
  });

  test('findBestAgent excludes sender', async () => {
    const cl = require('../lib/agentBus/collaborationLoop');
    const agents = [{ uid: 'sender-1', capabilities: ['testing'] }];
    const best = cl.findBestAgent(agents, ['testing'], 'sender-1');
    assert.equal(best, null, 'should return null when no candidates besides sender');
  });
});

// ── generalist agent (#72) ─────────────────────────────────────────

describe('collaborationLoop — generalist (#72)', () => {
  test('ensureGeneralistAgent registers generalist', async () => {
    const cl = require('../lib/agentBus/collaborationLoop');
    const registry = require('../lib/agentBus/registry');

    const uid = await cl.ensureGeneralistAgent(registry, 'boos');
    assert.ok(uid);
    assert.equal(cl.getGeneralistUid(), uid);
  });

  test('GENERALIST_NAME constant is defined', () => {
    const cl = require('../lib/agentBus/collaborationLoop');
    assert.equal(cl.GENERALIST_NAME, '通用助手');
  });
});
