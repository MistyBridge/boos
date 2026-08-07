// Task timeout scanner — Sprint 8 #61, Sprint 11 revised, Sprint 36 adapted.
//
// Periodic scan for tasks stuck in pending/in_progress > 24h.
// On timeout: archive once (single notification), no retries.
//
// Sprint 36: Adapted to scan per-agent inbox files
// (~/.boos/agent-bus/inbox/<uid>.json) instead of the old shared
// agent-bus.json. The shared store was deprecated in Sprint 35 when
// tasks moved to per-agent inbox files.
//
// Rationale: 30min was too aggressive for real development workflows.
// 24h gives agents meaningful time while preventing indefinite zombie tasks.

'use strict';

const path = require('path');
const fs = require('fs');
const { INBOX_DIR, loadInboxSync, saveInbox, archiveTask } = require('./inboxStore');
const errReport = require("../errorReport");

const TIMEOUT_MS = 24 * 60 * 60 * 1000;  // Sprint 11: 24h (was 30min)
const SCAN_INTERVAL_MS = 60_000;          // scan every 60s

let _timer = null;
const _notifiedOnce = new Set();  // track tasks that have already been notified

function start(storeRef, onTimeout) {
  if (_timer) return;
  _timer = setInterval(() => _scan(onTimeout), SCAN_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function _scan(onTimeout) {
  try {
    // Sprint 36: scan per-agent inbox files instead of shared agent-bus.json.
    const now = Date.now();
    let inboxFiles = [];
    try {
      inboxFiles = fs.readdirSync(INBOX_DIR).filter((f) => f.endsWith('.json'));
    } catch (e) {
      if (e.code === 'ENOENT') return; // no inbox dir yet
      throw e;
    }

    for (const filename of inboxFiles) {
      const uid = filename.replace(/\.json$/, '');
      const inbox = loadInboxSync(uid);
      let modified = false;

      for (const arr of [inbox.pending, inbox.in_progress]) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const t = arr[i];
          if (!t.task_id) continue;
          const age = now - new Date(t.created_at).getTime();
          if (age < TIMEOUT_MS) continue;

          const elapsedH = Math.round(age / 3600000);

          // Notify exactly once — no duplicate noise.
          if (!_notifiedOnce.has(t.task_id)) {
            _notifiedOnce.add(t.task_id);

            // Archive task with full context for traceability.
            const archived = {
              sender_uid: t.sender_uid,
              sender_name: t.sender_name || (t.sender && t.sender.name),
              receiver_uid: t.receiver_uid || uid,
              content: t.content,
              status: 'exhausted',
              priority: t.priority,
              retry_count: t.retry_count || 0,
              created_at: t.created_at,
              claimed_at: t.claimed_at || null,
              elapsed_hours: elapsedH,
              timeout_reason: 'Exceeded 24h timeout',
              timed_out_at: new Date().toISOString(),
            };
            archiveTask(uid, archived).catch(() => {});

            // Notify sender.
            if (onTimeout) onTimeout(t);
          }

          // Remove from inbox (scanning backwards, safe to splice).
          arr.splice(i, 1);
          modified = true;
        }
      }

      if (modified) {
        saveInbox(uid, inbox).catch(() => {});
      }
    }
  } catch (e) { errReport.report("taskTimeout", "splice", e); }
}

module.exports = { start, stop, TIMEOUT_MS };
