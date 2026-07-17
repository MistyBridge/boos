// IdentityResolver — canonical agent identity resolution.
// ============================================================
//
// BOOS has four ID types for the same agent:
//   agentUid     "agent_mrj7kjfv_k5ze3t"   agent-bus persistent UID
//   transportId  "mcp_abc123..."            MCP SSE transport session
//   boosSession  "sess-mrjzq52x-g3fcud"    BOOS persisted session
//   nameWs       "前端工程师|boos"           name + workspace compound
//
// This class wraps the existing store/identity infrastructure and
// resolves ANY input to the canonical BOOS session ID.
//
// DESIGN PRINCIPLE (risk-controlled):
//   This is an AUGMENTATION.  Every existing code path (store.getIdentity,
//   _findSessionByUid, _allAgentIds, _resolveFolderId) stays intact.
//   Callers use the resolver as a clean primary path; old code remains
//   as fallback.  Dual-channel: both work independently, no deletions.
//
// Usage:
//   const { IdentityResolver } = require('./identityResolver');
//   const resolver = new IdentityResolver(store);
//   const canon = resolver.canonical('agent_mrj7kjfv_k5ze3t');
//   // → 'sess-mrjzq52x-g3fcud'  (or null)
//   const ids = resolver.expand('agent_mrj7kjfv_k5ze3t');
//   // → Set(['agent_mrj7kjfv_k5ze3t', 'mcp_xxx', 'sess-...', 'name|ws', 'name'])

'use strict';

class IdentityResolver {
  /**
   * @param {object} store — agent-bus store (lib/agentBus/store)
   */
  constructor(store) {
    this._store = store;
  }

  // ── Canonical resolution ───────────────────────────────────────────
  // Resolve ANY identity fragment → canonical BOOS session ID (string)
  // or null if the input cannot be resolved.

  /**
   * Resolve to canonical BOOS session ID.
   *
   * @param {string} input      — agentUid / transportId / boosSessionId / nameWs compound / bare name
   * @param {string} [workspace] — required if input is a bare name
   * @returns {string|null}
   */
  canonical(input, workspace) {
    if (!input) return null;

    // ── 1. Input IS a BOOS session ID ──
    if (input.startsWith('sess-')) {
      const identity = this._store.getIdentity({ boosSessionId: input });
      return identity?.boos_session_id || input;
    }

    // ── 2. agent-bus UID ──
    if (input.startsWith('agent_')) {
      return this._uidToBoos(input);
    }

    // ── 3. Transport (MCP) session ID ──
    if (input.startsWith('mcp_')) {
      const uid = this._store.getSessionAgentUid(input);
      if (uid) return this._uidToBoos(uid);
      return null;
    }

    // ── 4. "name|workspace" compound ──
    if (input.includes('|')) {
      const [name, ws] = input.split('|');
      return this._nameWsToBoos(name, ws);
    }

    // ── 5. Bare name → requires workspace or fuzzy scan ──
    if (workspace) return this._nameWsToBoos(input, workspace);
    return this._nameToBoos(input);
  }

  // ── ID expansion ───────────────────────────────────────────────────
  // For permission checks: get ALL known IDs so callers can match
  // against agentLevels keyed by any ID type.

  /**
   * Return a Set of ALL known IDs for the given agent.
   * Use for matching against agentLevels which may be keyed by
   * agent-bus UID, transport session ID, or BOOS session ID.
   *
   * @returns {Set<string>}
   */
  expand(input, workspace) {
    const ids = new Set();
    if (!input) return ids;

    // Always include the input itself.
    ids.add(input);

    // Resolve the identity card.
    let identity = null;
    if (input.startsWith('agent_')) {
      identity = this._store.getIdentity({ uid: input });
    } else if (input.startsWith('sess-')) {
      identity = this._store.getIdentity({ boosSessionId: input });
    } else if (input.startsWith('mcp_')) {
      const uid = this._store.getSessionAgentUid(input);
      if (uid) {
        ids.add(uid);
        identity = this._store.getIdentity({ uid });
      }
    } else {
      // Bare name or name|ws.
      const name = input.includes('|') ? input.split('|')[0] : input;
      const ws = input.includes('|') ? input.split('|')[1] : (workspace || null);
      identity = this._store.getIdentity({ name, workspace: ws });
    }

    if (identity) {
      if (identity.agent_uid) ids.add(identity.agent_uid);
      if (identity.boos_session_id) ids.add(identity.boos_session_id);
      if (identity.mcp_session_id) ids.add(identity.mcp_session_id);
      if (identity.name && identity.workspace) ids.add(identity.name + '|' + identity.workspace);
      if (identity.name) ids.add(identity.name);
    }

    // Also get transport session ID from store.sessions.
    const uid = identity?.agent_uid || (input.startsWith('agent_') ? input : null);
    if (uid) {
      const transportId = this._store.getSessionByAgentUid(uid);
      if (transportId) ids.add(transportId);
    }

    return ids;
  }

  // ── Type converters (convenience) ──────────────────────────────────

  /** Any input → agent-bus UID */
  toAgentUid(input, workspace) {
    if (input?.startsWith('agent_')) return input;
    const boosId = this.canonical(input, workspace);
    if (!boosId) return null;
    const identity = this._store.getIdentity({ boosSessionId: boosId });
    return identity?.agent_uid || null;
  }

  /** Any input → BOOS session ID (alias for canonical) */
  toBoosSession(input, workspace) {
    return this.canonical(input, workspace);
  }

  /** Any input → transport (MCP) session ID */
  toTransportId(input, workspace) {
    const uid = this.toAgentUid(input, workspace);
    return uid ? this._store.getSessionByAgentUid(uid) : null;
  }

  // ── Private helpers ────────────────────────────────────────────────

  _uidToBoos(agentUid) {
    const identity = this._store.getIdentity({ uid: agentUid });
    if (identity?.boos_session_id) return identity.boos_session_id;

    // Cross-reference: transport session → might be a BOOS ID directly.
    const transportId = this._store.getSessionByAgentUid(agentUid);
    if (transportId?.startsWith('sess-')) return transportId;

    // Last resort: name+workspace cross-reference.
    const agent = this._store.getAgent(agentUid);
    if (agent?.name && agent?.workspace) {
      return this._nameWsToBoos(agent.name, agent.workspace);
    }
    return null;
  }

  _nameWsToBoos(name, workspace) {
    const identity = this._store.getIdentity({ name, workspace });
    return identity?.boos_session_id || null;
  }

  _nameToBoos(name) {
    const identity = this._store.getIdentity({ name });
    return identity?.boos_session_id || null;
  }
}

// ── Singleton (created at server boot) ───────────────────────────────

let _instance = null;

function getResolver() {
  if (_instance) return _instance;
  const store = require('./agentBus/store');
  _instance = new IdentityResolver(store);
  return _instance;
}

module.exports = { IdentityResolver, getResolver };
