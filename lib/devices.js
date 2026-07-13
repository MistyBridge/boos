'use strict';

// Remote-device approval store. Each browser that arrives via the tunnel
// generates a UUID client-side (`boos.deviceId` in localStorage) and sends
// it as `X-Device-Id` on every API call. server.js' middleware feeds those
// arrivals through record() — known devices get their lastSeen bumped,
// new ones get inserted as `pending`. Until the host explicitly Approves
// from the Remote page, every non-loopback request returns 403 with the
// pending status.
//
// Stored at ~/.boos/devices.json:
//   {
//     "<uuid>": {
//       id, status: 'pending'|'approved'|'rejected',
//       userAgent, ip,
//       firstSeen, lastSeen, approvedAt,
//       label                  // user-set or auto-derived from UA
//     },
//     ...
//   }

const { DATA_DIR } = require('./config');
const { createKeyedJsonStore } = require('./jsonStore');
const { withFileLock } = require('./atomicJson');

const store = createKeyedJsonStore({
  dataDir: DATA_DIR,
  filename: 'devices.json',
});

// `record()` runs on EVERY non-loopback API request. Two side effects
// without these guards:
//   1. Concurrent calls each do load→mutate→save independently; the
//      parallel rename(tmp → target) collides on Windows and surfaces
//      as `EPERM: operation not permitted`.
//   2. Even when serialized, writing on every request hammers the disk
//      for a value that only needs ~minute-grained accuracy (lastSeen
//      drives "seen 5m ago" labels in the UI).
// Fix: serialize all mutators through the shared per-file lock, and
// short-circuit lastSeen-only updates that landed within MIN_FLUSH_MS
// of the last persisted write for the same id.
const MIN_FLUSH_MS = 15_000;
const lastFlushAt = new Map();   // id → ms timestamp of last save

// Pending entries older than 24h are auto-pruned on each list() so a
// drive-by scanner doesn't grow the file forever. Rejected entries kept
// 1h so the host can see what got bounced and rename / un-reject if
// they realize it was legit.
const PENDING_TTL_MS  = 24 * 60 * 60 * 1000;
const REJECTED_TTL_MS = 60 * 60 * 1000;

// Quick UA → human-readable label. We keep this tiny on purpose — full
// UA parsing libraries are huge and the only consumer is one line in
// the approval UI. Order matters: Edge UA includes "Chrome" so detect
// Edge first.
function describeUA(ua) {
  ua = String(ua || '');
  const device =
    /iPhone/.test(ua)       ? 'iPhone'
    : /iPad/.test(ua)       ? 'iPad'
    : /Android/.test(ua)    ? 'Android'
    : /Mac OS X/.test(ua)   ? 'Mac'
    : /Windows/.test(ua)    ? 'Windows'
    : /Linux/.test(ua)      ? 'Linux'
    : null;
  const browser =
    /Edg\//.test(ua)        ? 'Edge'
    : /OPR\//.test(ua)      ? 'Opera'
    : /Chrome\//.test(ua)   ? 'Chrome'
    : /Firefox\//.test(ua)  ? 'Firefox'
    : /Safari\//.test(ua)   ? 'Safari'
    : null;
  if (device && browser) return `${device} · ${browser}`;
  if (device)            return device;
  if (browser)           return browser;
  return 'Unknown device';
}

async function pruneStale(map) {
  const now = Date.now();
  let dirty = false;
  for (const [id, d] of Object.entries(map)) {
    if (d.status === 'pending'  && now - d.firstSeen > PENDING_TTL_MS)  { delete map[id]; dirty = true; }
    if (d.status === 'rejected' && now - (d.rejectedAt || d.lastSeen) > REJECTED_TTL_MS) { delete map[id]; dirty = true; }
  }
  if (dirty) await store.save(map);
  return map;
}

// Upsert. Returns the (possibly newly-created) device record. Caller
// uses .status to decide whether to gate further work.
async function record(id, { userAgent, ip, code } = {}) {
  if (!id) throw new Error('device id required');
  return withFileLock(store.filePath, async () => {
    const map = await store.load();
    const now = Date.now();
    const existing = map[id];
    if (existing) {
      // Throttled lastSeen update: if the only thing that would change
      // is lastSeen and we flushed for this id within MIN_FLUSH_MS,
      // return the in-memory copy without touching disk. Saves a
      // disk write per request when remote pages poll at 2.5s.
      const recentlyFlushed = (now - (lastFlushAt.get(id) || 0)) < MIN_FLUSH_MS;
      let nonLastSeenChange = false;
      existing.lastSeen = now;
      if (userAgent && !existing.userAgent) { existing.userAgent = userAgent; nonLastSeenChange = true; }
      if (ip && existing.ip !== ip)         { existing.ip = ip; nonLastSeenChange = true; }
      // Backfill code on existing records that pre-date the field, but
      // never overwrite a code we've already stored — a device's code
      // is its identifier across the approval flow and changing it
      // mid-request would defeat the disambiguation it exists for.
      if (code && !existing.code) {
        existing.code = String(code).slice(0, 8);
        nonLastSeenChange = true;
      }
      if (!nonLastSeenChange && recentlyFlushed) return existing;
      await store.save(map);
      lastFlushAt.set(id, now);
      return existing;
    }
    map[id] = {
      id,
      status: 'pending',
      userAgent: userAgent || null,
      ip: ip || null,
      // 4-digit identification code the requesting browser generated
      // and stashed in its own localStorage. Purely human-facing;
      // the Remote page renders it next to each pending device so the
      // operator can match against what the user reads off their
      // screen before clicking Approve. Not a credential.
      code: code ? String(code).slice(0, 8) : null,
      firstSeen: now,
      lastSeen: now,
      approvedAt: null,
      rejectedAt: null,
      label: describeUA(userAgent),
    };
    await store.save(map);
    lastFlushAt.set(id, now);
    return map[id];
  });
}

async function get(id) {
  const map = await store.load();
  return map[id] || null;
}

async function isApproved(id) {
  const d = await get(id);
  return !!(d && d.status === 'approved');
}

async function approve(id, label) {
  return withFileLock(store.filePath, async () => {
    const map = await store.load();
    const d = map[id];
    if (!d) return null;
    d.status = 'approved';
    d.approvedAt = Date.now();
    d.rejectedAt = null;
    if (label) d.label = String(label);
    await store.save(map);
    lastFlushAt.set(id, Date.now());
    return d;
  });
}

async function reject(id) {
  return withFileLock(store.filePath, async () => {
    const map = await store.load();
    const d = map[id];
    if (!d) return null;
    d.status = 'rejected';
    d.rejectedAt = Date.now();
    d.approvedAt = null;
    await store.save(map);
    lastFlushAt.set(id, Date.now());
    return d;
  });
}

// Identical to reject in storage terms, but separate API name so the UI
// can distinguish "I'm declining a new request" from "I'm taking back
// access from someone I'd previously approved". Both end up status:
// 'rejected' and clear approvedAt — once cleared, the device must
// request again from scratch.
async function revoke(id) {
  return reject(id);
}

async function rename(id, label) {
  return withFileLock(store.filePath, async () => {
    const map = await store.load();
    const d = map[id];
    if (!d) return null;
    d.label = String(label || '').slice(0, 60);
    await store.save(map);
    return d;
  });
}

async function remove(id) {
  return store.remove(id);
}

async function list() {
  const map = await pruneStale(await store.load());
  return Object.values(map).sort((a, b) => {
    // Pending first (so the host sees them at the top), then approved
    // by approvedAt desc, then rejected by rejectedAt desc.
    const order = { pending: 0, approved: 1, rejected: 2 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
}

module.exports = {
  record,
  get,
  isApproved,
  approve,
  reject,
  revoke,
  rename,
  remove,
  list,
  describeUA,
};
