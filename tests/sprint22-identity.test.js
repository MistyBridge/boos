// Sprint 22 Phase 6: 统一原子身份索引 — 全链路测试
// Tests: writeIdentity (via upsertIdentity), identity indices, regression
//
// Run: node --test tests/sprint22-identity.test.js

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Helpers ───────────────────────────────────────────────────────────

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Read DB through store's own path resolution
async function readDb() {
  return store._load();
}

// ── Suite ─────────────────────────────────────────────────────────────

const TEST_HOME = path.join(os.tmpdir(), 'boos-sprint22-test');
const DATA_DIR = path.join(TEST_HOME, '.boos');

let store;

describe('Sprint 22: Identity Index Tests', () => {

  before(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Set BOOS_HOME BEFORE requiring store to ensure config.js picks it up
    process.env.BOOS_HOME = TEST_HOME;
    // Clear require cache for config/store to ensure fresh load with correct env
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/agentBus/store')];
    store = require('../lib/agentBus/store');
  });

  // ═══════════════════════════════════════════════════════════════════
  // writeIdentity tests (via upsertIdentity public API)
  // ═══════════════════════════════════════════════════════════════════
  describe('writeIdentity (via upsertIdentity)', () => {

    test('boos_session_id → identity_by_boos_session index', async () => {
      const agentUid = uid('a');
      const boosSid = 'boos-session-' + Date.now();

      await store.upsertIdentity(agentUid, {
        name: 'TestAgent', workspace: 'boos', boos_session_id: boosSid,
      });

      // Verify via store API
      const id = store.getIdentity({ uid: agentUid });
      assert.ok(id, 'identity exists');
      assert.strictEqual(id.boos_session_id, boosSid, 'boos_session_id set');

      const byBoos = store.getIdentity({ boosSessionId: boosSid });
      assert.ok(byBoos, 'lookup by boosSessionId works');
      assert.strictEqual(byBoos.agent_uid, agentUid, 'correct agentUid');

      // Verify index via DB read
      const db = await readDb();
      assert.strictEqual(db.identity_by_boos_session[boosSid], agentUid, 'index entry exists');
    });

    test('mcp_session_id → identity_by_mcp_session index (核心修复)', async () => {
      const agentUid = uid('a');
      const mcpSid = 'mcp-sess-' + Date.now();

      await store.upsertIdentity(agentUid, {
        name: 'TestAgent2', workspace: 'boos', mcp_session_id: mcpSid,
      });

      const db = await readDb();
      assert.strictEqual(db.identity_by_mcp_session[mcpSid], agentUid,
        'identity_by_mcp_session index populated');
    });

    test('name+workspace → identity_by_name_ws index', async () => {
      const agentUid = uid('a');
      await store.upsertIdentity(agentUid, {
        name: 'ByNameWsAgent', workspace: 'load-test',
      });

      const db = await readDb();
      assert.strictEqual(db.identity_by_name_ws['ByNameWsAgent|load-test'], agentUid,
        'name_ws index entry');

      const id = store.getIdentity({ name: 'ByNameWsAgent', workspace: 'load-test' });
      assert.ok(id, 'lookup by name+workspace works');
      assert.strictEqual(id.agent_uid, agentUid);
    });

    test('three writes — old indices cleaned, new exist', async () => {
      const agentUid = uid('multi');
      const oldBoos = 'old-boos-' + Date.now();
      const newBoos = 'new-boos-' + Date.now();
      const mcpSid = 'mcp-' + Date.now();

      await store.upsertIdentity(agentUid, { boos_session_id: oldBoos, name: 'Multi', workspace: 'boos' });
      await store.upsertIdentity(agentUid, { boos_session_id: newBoos });
      await store.upsertIdentity(agentUid, { mcp_session_id: mcpSid });

      const db = await readDb();
      assert.strictEqual(db.identity_by_boos_session[oldBoos], undefined, 'old boos index removed');
      assert.strictEqual(db.identity_by_boos_session[newBoos], agentUid, 'new boos index exists');
      assert.strictEqual(db.identity_by_mcp_session[mcpSid], agentUid, 'mcp index exists');
      assert.strictEqual(db.identity_by_name_ws['Multi|boos'], agentUid, 'name_ws persists');
    });

    test('null values excluded from indices (Sprint 22: no more __pending__)', async () => {
      const agentUid = uid('nullv');
      await store.writeIdentity(agentUid, {
        name: 'NullAgent', workspace: 'boos',
        boos_session_id: null, mcp_session_id: null,
      });

      const db = await readDb();
      assert.strictEqual(db.identity_by_boos_session['null'], undefined, 'null not in boos index');
      assert.strictEqual(db.identity_by_boos_session[''], undefined, 'empty not in boos index');
      assert.strictEqual(db.identity_by_name_ws['NullAgent|boos'], agentUid, 'name_ws works');

      const id = store.getIdentity({ uid: agentUid });
      assert.ok(id);
      assert.strictEqual(id.boos_session_id, null);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // rebuildAllIndices
  // ═══════════════════════════════════════════════════════════════════
  describe('rebuildAllIndices', () => {

    test('rebuilds all 3 indices from identity records', async () => {
      const ag1 = uid('rb1'), ag2 = uid('rb2');
      const boos1 = 'b1-' + Date.now(), mcp1 = 'm1-' + Date.now();
      const boos2 = 'b2-' + Date.now();

      await store.upsertIdentity(ag1, { name: 'R1', workspace: 'sprint22', boos_session_id: boos1, mcp_session_id: mcp1 });
      await store.upsertIdentity(ag2, { name: 'R2', workspace: 'sprint22', boos_session_id: boos2 });

      // Corrupt indices manually
      let db = await readDb();
      db.identity_by_boos_session = {};
      db.identity_by_mcp_session = {};
      db.identity_by_name_ws = {};
      // Write corrupted DB back
      const { atomicWriteJson } = require('../lib/atomicJson');
      await atomicWriteJson(store.DB_PATH, db);

      // Rebuild
      const count = await store.rebuildAllIndices();
      assert.ok(count >= 2, `at least 2 rebuilt, got ${count}`);

      // Verify
      db = await readDb();
      assert.strictEqual(db.identity_by_boos_session[boos1], ag1, 'boos1 restored');
      assert.strictEqual(db.identity_by_mcp_session[mcp1], ag1, 'mcp1 restored');
      assert.strictEqual(db.identity_by_name_ws['R1|sprint22'], ag1, 'name_ws1 restored');
      assert.strictEqual(db.identity_by_boos_session[boos2], ag2, 'boos2 restored');
    });

    test('skips null/falsy session IDs (Sprint 22: no more sentinels)', async () => {
      const ag = uid('skip');
      const realMcp = 'real-mcp-' + Date.now();
      await store.writeIdentity(ag, { name: 'Skip', workspace: 'sprint22',
        boos_session_id: null, mcp_session_id: realMcp });

      let db = await readDb();
      db.identity_by_boos_session = {};
      db.identity_by_mcp_session = {};
      db.identity_by_name_ws = {};
      const { atomicWriteJson } = require('../lib/atomicJson');
      await atomicWriteJson(store.DB_PATH, db);

      await store.rebuildAllIndices();

      db = await readDb();
      // Sprint 22: null/falsy values are skipped by truthy check.
      assert.strictEqual(db.identity_by_boos_session.null, undefined, 'null not in boos index');
      assert.strictEqual(db.identity_by_mcp_session[realMcp], ag, 'real mcp id IS indexed');
      assert.strictEqual(db.identity_by_name_ws['Skip|sprint22'], ag, 'name_ws rebuilt');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getAgentUidByMcpSession
  // ═══════════════════════════════════════════════════════════════════
  describe('getAgentUidByMcpSession', () => {

    test('resolves UID from mcp_session_id', async () => {
      const agentUid = uid('mcp');
      const mcpSid = 'mcp-lookup-' + Date.now();
      await store.upsertIdentity(agentUid, { mcp_session_id: mcpSid, name: 'Mcp', workspace: 'boos' });
      assert.strictEqual(store.getAgentUidByMcpSession(mcpSid), agentUid);
    });

    test('returns null for unknown mcp_session_id', () => {
      assert.strictEqual(store.getAgentUidByMcpSession('nonex-' + Date.now()), null);
    });

    test('after rebinding, old index gone, new exists', async () => {
      const agentUid = uid('rebind');
      const oldMcp = 'old-mcp-' + Date.now();
      const newMcp = 'new-mcp-' + Date.now();

      await store.upsertIdentity(agentUid, { mcp_session_id: oldMcp, name: 'Rebind', workspace: 'boos' });
      await store.upsertIdentity(agentUid, { mcp_session_id: newMcp });

      const db = await readDb();
      assert.strictEqual(db.identity_by_mcp_session[oldMcp], undefined, 'old mcp cleaned');
      assert.strictEqual(db.identity_by_mcp_session[newMcp], agentUid, 'new mcp exists');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Integration: full write + read cycle
  // ═══════════════════════════════════════════════════════════════════
  describe('identity card lifecycle (integration)', () => {

    test('full write + read across all 3 indices', async () => {
      const agentUid = uid('full');
      const boosSid = 'bs-' + Date.now();
      const mcpSid = 'ms-' + Date.now();

      await store.upsertIdentity(agentUid, {
        name: 'FullAgent', workspace: 'integration-test',
        boos_session_id: boosSid, mcp_session_id: mcpSid,
      });

      const byUid = store.getIdentity({ uid: agentUid });
      const byBoos = store.getIdentity({ boosSessionId: boosSid });
      const byNameWs = store.getIdentity({ name: 'FullAgent', workspace: 'integration-test' });
      const byMcp = store.getAgentUidByMcpSession(mcpSid);

      assert.ok(byUid && byBoos && byNameWs, 'all 3 lookup methods work');
      assert.strictEqual(byMcp, agentUid, 'mcp lookup works');
      assert.strictEqual(byUid.agent_uid, agentUid);
      assert.strictEqual(byBoos.agent_uid, agentUid);
      assert.strictEqual(byNameWs.agent_uid, agentUid);
    });
  });

});
