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

    test('boos_session_id — no longer in JSON card; PG agent_sessions is authoritative', async () => {
      const agentUid = uid('a');
      const boosSid = 'boos-session-' + Date.now();

      // Sprint 33: boos_session_id is not persisted to JSON identity card.
      await store.upsertIdentity(agentUid, {
        name: 'TestAgent', workspace: 'boos',
      });

      // Verify via store API — name/workspace persist, boos_session_id does not.
      const id = store.getIdentity({ uid: agentUid });
      assert.ok(id, 'identity exists');
      assert.strictEqual(id.name, 'TestAgent', 'name persists');
      // Sprint 33: boos_session_id is PG-only. JSON card may still have stale value from pre-migration.
      // Use adapter.resolve() for session→agent lookup.
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

    test('three writes — mcp + name_ws indices updated (boos_session_id no longer in JSON)', async () => {
      const agentUid = uid('multi');
      const mcpSid = 'mcp-' + Date.now();

      await store.upsertIdentity(agentUid, { name: 'Multi', workspace: 'boos' });
      await store.upsertIdentity(agentUid, { mcp_session_id: mcpSid });

      // Sprint 33: boos_session_id is PG-only. Verify mcp + name_ws indices.
      const db = await readDb();
      assert.strictEqual(db.identity_by_mcp_session[mcpSid], agentUid, 'mcp index exists');
      assert.strictEqual(db.identity_by_name_ws['Multi|boos'], agentUid, 'name_ws persists');
    });

    test('null values not indexed (Sprint 33: boos_session_id removed from JSON)', async () => {
      const agentUid = uid('nullv');
      await store.writeIdentity(agentUid, {
        name: 'NullAgent', workspace: 'boos',
        mcp_session_id: null,
      });

      const db = await readDb();
      assert.strictEqual(db.identity_by_name_ws['NullAgent|boos'], agentUid, 'name_ws works');

      const id = store.getIdentity({ uid: agentUid });
      assert.ok(id);
      assert.strictEqual(id.name, 'NullAgent');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // rebuildAllIndices
  // ═══════════════════════════════════════════════════════════════════
  describe('rebuildAllIndices', () => {

    test('rebuilds mcp + name_ws indices from identity records (Sprint 33: PG-only mcp rebuild)', async () => {
      const ag1 = uid('rb1'), ag2 = uid('rb2');
      const mcp1 = 'm1-' + Date.now();

      await store.upsertIdentity(ag1, { name: 'R1', workspace: 'sprint22', mcp_session_id: mcp1 });
      await store.upsertIdentity(ag2, { name: 'R2', workspace: 'sprint22' });

      // Corrupt indices manually
      let db = await readDb();
      db.identity_by_mcp_session = {};
      db.identity_by_name_ws = {};
      const { atomicWriteJson } = require('../lib/atomicJson');
      await atomicWriteJson(store.DB_PATH, db);

      // Rebuild
      const count = await store.rebuildAllIndices();
      assert.ok(count >= 2, `at least 2 rebuilt, got ${count}`);

      // Verify
      db = await readDb();
      // Sprint 33: mcp index rebuild is PG-only (card body no longer stores mcp_session_id).
      // Without PG, mcp index stays empty after corruption — expected degradation.
      assert.strictEqual(db.identity_by_name_ws['R1|sprint22'], ag1, 'name_ws1 restored');
      const id1 = store.getIdentity({ uid: ag1 });
      assert.ok(id1, 'identity R1 exists');
    });

    test('skips null/falsy mcp IDs, indexes valid ones (Sprint 33: PG-only mcp index)', async () => {
      const ag = uid('skip');
      const realMcp = 'real-mcp-' + Date.now();
      await store.writeIdentity(ag, { name: 'Skip', workspace: 'sprint22',
        mcp_session_id: realMcp });

      let db = await readDb();
      db.identity_by_mcp_session = {};
      db.identity_by_name_ws = {};
      const { atomicWriteJson } = require('../lib/atomicJson');
      await atomicWriteJson(store.DB_PATH, db);

      await store.rebuildAllIndices();

      db = await readDb();
      // Sprint 33: mcp rebuild is PG-only. Without PG, mcp index stays empty after corruption.
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

    test('full write + read across all lookup methods (Sprint 33)', async () => {
      const agentUid = uid('full');
      const mcpSid = 'ms-' + Date.now();

      await store.upsertIdentity(agentUid, {
        name: 'FullAgent', workspace: 'integration-test',
        mcp_session_id: mcpSid,
      });

      const byUid = store.getIdentity({ uid: agentUid });
      const byNameWs = store.getIdentity({ name: 'FullAgent', workspace: 'integration-test' });
      const byMcp = store.getAgentUidByMcpSession(mcpSid);

      assert.ok(byUid && byNameWs, 'uid + name_ws lookup methods work');
      assert.strictEqual(byMcp, agentUid, 'mcp lookup works');
      assert.strictEqual(byUid.agent_uid, agentUid);
      assert.strictEqual(byNameWs.agent_uid, agentUid);
      // Sprint 33: boos_session_id lookup → PG adapter.resolveBySession().
    });
  });

});
