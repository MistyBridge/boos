'use strict';

// Tests for the Non-blocking Decision System (lib/decisionSystem.js).
// Decisions are persisted as .md files with YAML front matter.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── helpers ───────────────────────────────────────────────────────────

function setupBoosHome() {
  const dir = path.join(os.tmpdir(), `boos-test-dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.BOOS_HOME = dir;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('lib' + path.sep + 'config.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'decisionSystem.js')) delete require.cache[key];
  }
  return dir;
}

function teardownBoosHome(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('Decision System', () => {
  let ds;
  let boosHome;
  const AGENT = { uid: 'agent_test_001', name: 'TestAgent', workspace: 'test-ws' };

  beforeEach(() => {
    boosHome = setupBoosHome();
    ds = require('../lib/decisionSystem');
  });

  after(() => {
    if (boosHome) teardownBoosHome(boosHome);
  });

  // ── createDecision ───────────────────────────────────────────────────

  test('createDecision → file created in OPEN/ directory', () => {
    const r = ds.createDecision({
      agent_uid: AGENT.uid,
      agent_name: AGENT.name,
      workspace: AGENT.workspace,
      title: 'Should we migrate to Bun?',
      content: 'Pros: faster, Cons: ecosystem maturity',
      urgent: false,
    });
    assert.equal(r.ok, true);
    assert.ok(r.decision_id.startsWith('dec_'), 'decision_id should start with dec_');
    assert.ok(r.file_path.includes('OPEN'), 'file should be in OPEN dir');
    assert.ok(fs.existsSync(r.file_path), 'file should exist on disk');
    assert.equal(r.urgent, false);

    // Verify front matter content.
    const raw = fs.readFileSync(r.file_path, 'utf-8');
    assert.ok(raw.startsWith('---'), 'should have YAML front matter');
    assert.ok(raw.includes('Should we migrate to Bun?'), 'title in front matter');
    assert.ok(raw.includes(AGENT.uid), 'agent_uid in front matter');
    assert.ok(raw.includes('status: "open"'), 'status is "open"');
  });

  test('createDecision → urgent flag set correctly', () => {
    const r = ds.createDecision({
      agent_uid: AGENT.uid,
      agent_name: AGENT.name,
      workspace: AGENT.workspace,
      title: 'Critical security patch',
      content: 'Must deploy ASAP',
      urgent: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.urgent, true);

    const raw = fs.readFileSync(r.file_path, 'utf-8');
    assert.ok(raw.includes('urgent: true'));
  });

  test('createDecision → title truncated at 128 chars', () => {
    const longTitle = 'T'.repeat(200);
    const r = ds.createDecision({
      agent_uid: AGENT.uid, agent_name: AGENT.name,
      workspace: AGENT.workspace, title: longTitle, content: '',
    });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(r.file_path, 'utf-8');
    // The title in the front matter should be truncated.
    const titleMatch = raw.match(/title: "(.+)"/);
    assert.ok(titleMatch, 'title field should exist');
    assert.ok(titleMatch[1].length <= 128, 'title should be truncated');
  });

  // ── listDecisions ────────────────────────────────────────────────────

  test('listDecisions → status=open returns only OPEN decisions', () => {
    ds.createDecision({ ...AGENT, title: 'Open decision', content: '' });
    ds.createDecision({ ...AGENT, title: 'Another open', content: '' });

    const r = ds.listDecisions({ workspace: AGENT.workspace, status: 'open' });
    assert.ok(Array.isArray(r.decisions));
    assert.equal(r.decisions.length, 2);
    for (const d of r.decisions) {
      assert.equal(d.status, 'open');
    }
    assert.equal(r.count, 2);
  });

  test('listDecisions → empty workspace returns no results', () => {
    const r = ds.listDecisions({ workspace: 'nonexistent-ws', status: 'open' });
    assert.equal(r.decisions.length, 0);
  });

  test('listDecisions → status=all returns both OPEN and DECIDED', () => {
    const d1 = ds.createDecision({ ...AGENT, title: 'Will approve', content: '' });
    ds.approveDecision(d1.decision_id, 'host');

    const d2 = ds.createDecision({ ...AGENT, title: 'Still open', content: '' });

    const r = ds.listDecisions({ workspace: AGENT.workspace, status: 'all' });
    assert.equal(r.decisions.length, 2);
  });

  test('listDecisions → respects limit', () => {
    for (let i = 0; i < 5; i++) {
      ds.createDecision({ ...AGENT, title: `Decision ${i}`, content: '' });
    }

    const r = ds.listDecisions({ workspace: AGENT.workspace, status: 'open', limit: 3 });
    assert.equal(r.decisions.length, 3);
    assert.equal(r.count, 5); // total count ignores limit
  });

  // ── approveDecision / rejectDecision ─────────────────────────────────

  test('approveDecision → file moves to DECIDED/ with status=approved', () => {
    const d = ds.createDecision({ ...AGENT, title: 'Approve me', content: 'body' });
    const r = ds.approveDecision(d.decision_id, 'reviewer');

    assert.equal(r.ok, true);
    assert.equal(r.status, 'approved');
    assert.equal(r.approver, 'reviewer');

    // File should no longer be in OPEN.
    assert.ok(!fs.existsSync(d.file_path), 'file should be removed from OPEN');

    // File should be in DECIDED.
    const decidedDir = path.join(boosHome, 'decisions', 'DECIDED');
    const files = fs.readdirSync(decidedDir).filter((f) => f.startsWith(d.decision_id));
    assert.equal(files.length, 1, 'file should exist in DECIDED');

    const raw = fs.readFileSync(path.join(decidedDir, files[0]), 'utf-8');
    assert.ok(raw.includes('status: "approved"'), 'status should be "approved" in front matter');
  });

  test('rejectDecision → file moves to DECIDED/ with status=rejected', () => {
    const d = ds.createDecision({ ...AGENT, title: 'Reject me', content: '' });
    const r = ds.rejectDecision(d.decision_id, 'reviewer', 'Too risky');

    assert.equal(r.ok, true);
    assert.equal(r.status, 'rejected');
    assert.equal(r.comment, 'Too risky');

    const decidedDir = path.join(boosHome, 'decisions', 'DECIDED');
    const files = fs.readdirSync(decidedDir).filter((f) => f.startsWith(d.decision_id));
    assert.equal(files.length, 1);

    const raw = fs.readFileSync(path.join(decidedDir, files[0]), 'utf-8');
    assert.ok(raw.includes('status: "rejected"'));
  });

  test('approveDecision → non-existent decision returns error', () => {
    const r = ds.approveDecision('dec_nonexistent', 'host');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('not found'));
  });

  test('rejectDecision → non-existent decision returns error', () => {
    const r = ds.rejectDecision('dec_nonexistent', 'host', 'reason');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('not found'));
  });

  // ── getDecision ──────────────────────────────────────────────────────

  test('getDecision → returns metadata + markdown', () => {
    const d = ds.createDecision({ ...AGENT, title: 'Get me', content: 'The body text' });
    const r = ds.getDecision(d.decision_id);

    assert.ok(r.metadata, 'metadata should exist');
    assert.equal(r.metadata.title, 'Get me');
    assert.equal(r.metadata.status, 'open');
    assert.ok(r.markdown.includes('The body text'), 'markdown should contain body');
  });

  test('getDecision → non-existent returns null metadata and empty markdown', () => {
    const r = ds.getDecision('dec_nonexistent');
    assert.equal(r.metadata, null);
    assert.equal(r.markdown, '');
  });
});
