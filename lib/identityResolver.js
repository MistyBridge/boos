// IdentityResolver — async, delegates to PG adapter.
// ============================================================
//
// Sprint 33: ALL identity resolution goes through the PG adapter.
// JSON card (name+workspace) is degradation-only for sync lookups.
//
// Usage:
//   const resolver = getResolver();
//   const canon = await resolver.canonical(uuid);
//   const ids = await resolver.expand(uuid);

'use strict';

class IdentityResolver {
  constructor(store) {
    this._store = store;
  }

  // ── Canonical: any input → BOOS session ID ───────────────────────────

  async canonical(input, workspace) {
    if (!input) return null;

    // ── 1. BOOS session ID → resolve directly via adapter ──
    if (input.startsWith('sess-')) {
      const resolved = await this._adapter().resolveBySession(input);
      return resolved?.sessions?.[0] || input;
    }

    // ── 2. Agent UID → resolve session via adapter ──
    const agent = this._store.getAgent(input);
    if (agent || input.startsWith('agent_')) {
      const resolved = await this._adapter().resolve(input);
      if (resolved?.sessions?.length) return resolved.sessions[0];
      // Legacy: transport session → boos ID
      const transportId = this._store.getSessionByAgentUid(input);
      if (transportId?.startsWith('sess-')) return transportId;
      return null;
    }

    // ── 3. MCP transport ID ──
    if (input.startsWith('mcp_')) {
      const resolved = await this._adapter().resolveByMcp(input);
      if (resolved?.sessions?.length) return resolved.sessions[0];
      // Fallback: transport → agent uid → resolve
      const uid = this._store.getSessionAgentUid(input);
      if (uid) {
        const r2 = await this._adapter().resolve(uid);
        if (r2?.sessions?.length) return r2.sessions[0];
      }
      return null;
    }

    // ── 4. name|workspace ──
    if (input.includes('|')) {
      const [name, ws] = input.split('|');
      const resolved = await this._adapter().resolveByName(name, ws);
      return resolved?.sessions?.[0] || null;
    }

    // ── 5. Bare name ──
    const resolved = await this._adapter().resolveByName(input, workspace || 'boos');
    return resolved?.sessions?.[0] || null;
  }

  // ── ID expansion: all known IDs for permission checking ──────────────

  async expand(input, workspace) {
    const ids = new Set();
    if (!input) return ids;
    ids.add(input);

    let identity = null;

    if (input.startsWith('sess-')) {
      identity = await this._adapter().resolveBySession(input);
    } else if (input.startsWith('mcp_')) {
      identity = await this._adapter().resolveByMcp(input);
    } else if (this._store.getAgent(input)) {
      identity = await this._adapter().resolve(input);
    } else {
      const name = input.includes('|') ? input.split('|')[0] : input;
      const ws = input.includes('|') ? input.split('|')[1] : (workspace || 'boos');
      identity = await this._adapter().resolveByName(name, ws);
    }

    if (identity) {
      if (identity.uid) ids.add(identity.uid);
      if (identity.mcp_session_id) ids.add(identity.mcp_session_id);
      if (identity.name && identity.workspace) ids.add(identity.name + '|' + identity.workspace);
      if (identity.name) ids.add(identity.name);
      for (const sid of (identity.sessions || [])) ids.add(sid);
    }

    // Transport session from store.sessions table.
    const uid = identity?.uid || input;
    if (uid) {
      const transportId = this._store.getSessionByAgentUid(uid);
      if (transportId) ids.add(transportId);
    }

    return ids;
  }

  // ── Type converters ──────────────────────────────────────────────────

  async toAgentUid(input, workspace) {
    if (input?.startsWith('sess-')) return input;
    if (input?.startsWith('agent_')) return input;
    if (input && this._store.getAgent(input)) return input;
    const identity = await this._adapter().resolve(input) || await this._adapter().resolveByName(input, workspace || 'boos');
    return identity?.uid || null;
  }

  async toBoosSession(input, workspace) {
    return this.canonical(input, workspace);
  }

  async toTransportId(input, workspace) {
    const uid = await this.toAgentUid(input, workspace);
    return uid ? this._store.getSessionByAgentUid(uid) : null;
  }

  // ── Private ──────────────────────────────────────────────────────────

  _adapter() {
    if (!this._adapterCache) {
      this._adapterCache = require('./identityAdapter');
    }
    return this._adapterCache;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let _instance = null;

function getResolver() {
  if (_instance) return _instance;
  const store = require('./agentBus/store');
  _instance = new IdentityResolver(store);
  return _instance;
}

module.exports = { IdentityResolver, getResolver };
