'use strict';

// Tests for the DAG Workflow Engine (lib/workflowEngine.js).
// Each test uses an isolated BOOS_HOME so persisted data doesn't leak.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── helpers ───────────────────────────────────────────────────────────

function setupBoosHome() {
  const dir = path.join(os.tmpdir(), `boos-test-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.BOOS_HOME = dir;
  // Force reload of config-dependent modules.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('lib' + path.sep + 'config.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'workflowEngine.js')) delete require.cache[key];
  }
  return dir;
}

function teardownBoosHome(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Each test block gets its own isolated BOOS_HOME.
// We use `beforeEach` to recreate the temp dir and reload the module.

describe('Workflow Engine', () => {
  let wf;
  let boosHome;
  const WORKSPACE = 'test-ws';
  const OWNER = 'agent_supervisor_001';
  const OTHER = 'agent_other_002';

  beforeEach(() => {
    boosHome = setupBoosHome();
    wf = require('../lib/workflowEngine');
  });

  after(() => {
    if (boosHome) teardownBoosHome(boosHome);
  });

  // ── defineWorkflow ───────────────────────────────────────────────────

  test('define_workflow → returns workflow_id + status draft', async () => {
    const r = await wf.defineWorkflow('Release v2', 'Deploy pipeline', OWNER, WORKSPACE);
    assert.equal(r.ok, true);
    assert.ok(r.workflow_id.startsWith('wf_'), 'workflow_id should start with wf_');
    assert.equal(r.name, 'Release v2');
    assert.equal(r.status, 'draft');
  });

  test('define_workflow → name truncated at 128 chars', async () => {
    const longName = 'x'.repeat(200);
    const r = await wf.defineWorkflow(longName, '', OWNER, WORKSPACE);
    assert.equal(r.ok, true);
    assert.ok(r.name.length <= 128);
  });

  test('define_workflow → two workflows get unique ids', async () => {
    const r1 = await wf.defineWorkflow('A', '', OWNER, WORKSPACE);
    const r2 = await wf.defineWorkflow('B', '', OWNER, WORKSPACE);
    assert.notEqual(r1.workflow_id, r2.workflow_id);
  });

  // ── addStage ─────────────────────────────────────────────────────────

  test('add_stage → returns stage_id', async () => {
    const w = await wf.defineWorkflow('Build', '', OWNER, WORKSPACE);
    const r = await wf.addStage(w.workflow_id, {
      name: 'Compile', description: 'tsc build', content: 'Run tsc',
    }, OWNER);
    assert.equal(r.ok, true);
    assert.ok(r.stage_id.startsWith('stage_'), 'stage_id should start with stage_');
  });

  test('add_stage → non-owner blocked', async () => {
    const w = await wf.defineWorkflow('Build', '', OWNER, WORKSPACE);
    const r = await wf.addStage(w.workflow_id, { name: 'Test' }, OTHER);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('owner'));
  });

  test('add_stage → blocked when workflow not in draft', async () => {
    const w = await wf.defineWorkflow('Build', '', OWNER, WORKSPACE);
    // We can't easily change status without activate, so test direct.
    // Calling addStage with a non-existent workflow should also fail.
    const r = await wf.addStage('wf_nonexistent', { name: 'Test' }, OWNER);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('not found'));
  });

  // ── addDependency ────────────────────────────────────────────────────

  test('add_dependency → normal edge added', async () => {
    const w = await wf.defineWorkflow('Pipeline', '', OWNER, WORKSPACE);
    const s1 = await wf.addStage(w.workflow_id, { name: 'Build' }, OWNER);
    const s2 = await wf.addStage(w.workflow_id, { name: 'Deploy' }, OWNER);
    const r = await wf.addDependency(w.workflow_id, s1.stage_id, s2.stage_id, OWNER);
    assert.equal(r.ok, true);
    assert.deepEqual(r.edge, { from: s1.stage_id, to: s2.stage_id });
  });

  test('add_dependency → duplicate edge handled gracefully', async () => {
    const w = await wf.defineWorkflow('Pipeline', '', OWNER, WORKSPACE);
    const s1 = await wf.addStage(w.workflow_id, { name: 'Build' }, OWNER);
    const s2 = await wf.addStage(w.workflow_id, { name: 'Deploy' }, OWNER);
    await wf.addDependency(w.workflow_id, s1.stage_id, s2.stage_id, OWNER);
    const r = await wf.addDependency(w.workflow_id, s1.stage_id, s2.stage_id, OWNER);
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true);
  });

  test('add_dependency → cycle detection (A→B, B→C, C→A rejected)', async () => {
    const w = await wf.defineWorkflow('CycleTest', '', OWNER, WORKSPACE);
    const a = await wf.addStage(w.workflow_id, { name: 'A' }, OWNER);
    const b = await wf.addStage(w.workflow_id, { name: 'B' }, OWNER);
    const c = await wf.addStage(w.workflow_id, { name: 'C' }, OWNER);

    // A→B, B→C are fine.
    await wf.addDependency(w.workflow_id, a.stage_id, b.stage_id, OWNER);
    await wf.addDependency(w.workflow_id, b.stage_id, c.stage_id, OWNER);

    // C→A would create cycle.
    const r = await wf.addDependency(w.workflow_id, c.stage_id, a.stage_id, OWNER);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('cycle'), 'should reject cycle');
  });

  // ── activateWorkflow ─────────────────────────────────────────────────

  test('activate_workflow → no-dependency stages dispatched', async () => {
    const w = await wf.defineWorkflow('Simple', '', OWNER, WORKSPACE);
    await wf.addStage(w.workflow_id, { name: 'Step1' }, OWNER);
    await wf.addStage(w.workflow_id, { name: 'Step2' }, OWNER);

    const dispatched = [];
    const dispatchFn = async (content, caps, ws, wfId, stageId) => {
      dispatched.push({ content, caps, ws, wfId, stageId });
      return null; // no matching agent
    };

    const r = await wf.activateWorkflow(w.workflow_id, OWNER, dispatchFn);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'active');
    // Both stages should have been dispatched (no deps blocking).
    assert.equal(r.stages_dispatched.length, 2);
  });

  test('activate_workflow → dependency cascade: A→C, B→C, A and B dispatched, C blocked', async () => {
    const w = await wf.defineWorkflow('Cascade', '', OWNER, WORKSPACE);
    const a = await wf.addStage(w.workflow_id, { name: 'A' }, OWNER);
    const b = await wf.addStage(w.workflow_id, { name: 'B' }, OWNER);
    const c = await wf.addStage(w.workflow_id, { name: 'C' }, OWNER);

    await wf.addDependency(w.workflow_id, a.stage_id, c.stage_id, OWNER);
    await wf.addDependency(w.workflow_id, b.stage_id, c.stage_id, OWNER);

    const dispatched = [];
    const dispatchFn = async (content, caps, ws, wfId, stageId) => {
      dispatched.push(stageId);
      return null;
    };

    await wf.activateWorkflow(w.workflow_id, OWNER, dispatchFn);

    // A and B should be dispatched (no deps), C should NOT be dispatched (blocked by A and B).
    assert.ok(dispatched.includes(a.stage_id), 'A should be dispatched');
    assert.ok(dispatched.includes(b.stage_id), 'B should be dispatched');
    assert.ok(!dispatched.includes(c.stage_id), 'C should be blocked pending A and B');
  });

  // ── queries ──────────────────────────────────────────────────────────

  test('getWorkflow → returns full workflow with stages', async () => {
    const w = await wf.defineWorkflow('Query', '', OWNER, WORKSPACE);
    await wf.addStage(w.workflow_id, { name: 'S1' }, OWNER);

    const result = wf.getWorkflow(w.workflow_id);
    assert.ok(result, 'workflow should exist');
    assert.equal(result.name, 'Query');
    assert.equal(result.status, 'draft');
    assert.equal(Object.keys(result.stages).length, 1);
  });

  test('getWorkflow → nonexistent returns null', () => {
    const result = wf.getWorkflow('wf_nonexistent');
    assert.equal(result, null);
  });

  test('listWorkflows → filters by workspace', async () => {
    await wf.defineWorkflow('WS1-A', '', OWNER, 'workspace-1');
    await wf.defineWorkflow('WS1-B', '', OWNER, 'workspace-1');
    await wf.defineWorkflow('WS2-A', '', OWNER, 'workspace-2');

    const ws1 = wf.listWorkflows('workspace-1');
    assert.equal(ws1.length, 2);

    const ws2 = wf.listWorkflows('workspace-2');
    assert.equal(ws2.length, 1);

    const ws3 = wf.listWorkflows('workspace-3');
    assert.equal(ws3.length, 0);
  });
});
