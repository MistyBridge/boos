// Crash forensics — last-activity tracker for the death moment.
//
// Sprint 42: repeated boot crashes died with exit code 1 and ZERO log
// output — the async console pipeline drops buffered lines when the
// process exits via process.exit() (or dies natively), so "no error"
// meant "no evidence". This module keeps one tiny in-memory label that
// is OVERWRITTEN (never appended) at every interesting boundary, and
// server.js writes it to disk synchronously in process.on('exit') —
// writeFileSync cannot be lost.
//
// Sprint 42 fix (2026-08-07): process.on('exit') NEVER fires for a
// native-layer crash (node-pty/ConPTY TerminateProcess) — exactly the
// crash class this module exists for — so the in-memory label was never
// flushed and crash-forensics.json never appeared. note() now also
// sync-writes the marker to disk directly (throttled to ~10/s), so the
// file survives ANY death: native crash, hard kill, process.exit. The
// exit handler remains as the final flush.
//
// Call note() from every native-adjacent boundary: PTY write, PTY spawn,
// SQLite sync, boot injection, stale-reclaim. The label at death tells
// us which subsystem was in flight.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DATA_DIR = process.env.BOOS_HOME || path.join(os.homedir(), '.boos');
const MARKER_PATH = path.join(DATA_DIR, 'crash-marker.json');

let _lastActivity = 'boot';
let _detail = null;
let _lastDiskWrite = 0;
const DISK_THROTTLE_MS = 100; // sync write at most every 100ms (10/s)

function note(label, detail) {
  _lastActivity = String(label);
  _detail = detail || null;
  const now = Date.now();
  if (now - _lastDiskWrite < DISK_THROTTLE_MS) return;
  _lastDiskWrite = now;
  _writeDisk();
}

// Sync write — cannot be lost, but keep it cheap (throttled above).
function _writeDisk() {
  try {
    fs.writeFileSync(
      MARKER_PATH,
      JSON.stringify({ activity: _lastActivity, detail: _detail, ts: new Date().toISOString() }, null, 2),
      'utf-8',
    );
  } catch {}
}

function lastActivity() {
  return { activity: _lastActivity, detail: _detail };
}

module.exports = { note, lastActivity, MARKER_PATH };
