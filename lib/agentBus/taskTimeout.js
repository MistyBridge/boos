// Task timeout scanner — Sprint 8 #61, Sprint 11 revised.
//
// Periodic scan for tasks stuck in pending/in_progress > 24h.
// On timeout: archive once (single notification), no retries.
// Task stays traceable via ID in ~/.boos/archive/tasks/<yyyy-mm>/<id>.json.
//
// Rationale: 30min was too aggressive for real development workflows.
// 24h gives agents meaningful time while preventing indefinite zombie tasks.

'use strict';

const TIMEOUT_MS = 24 * 60 * 60 * 1000;  // Sprint 11: 24h (was 30min)
const SCAN_INTERVAL_MS = 60_000;          // scan every 60s

let _timer = null;
const _notifiedOnce = new Set();  // track tasks that have already been notified

function start(storeRef, onTimeout) {
  if (_timer) return;
  _timer = setInterval(() => _scan(storeRef, onTimeout), SCAN_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function _scan(storeRef, onTimeout) {
  try {
    const db = JSON.parse(require('fs').readFileSync(storeRef.DB_PATH, 'utf-8'));
    const now = Date.now();
    const archive = require('../archive');

    for (const t of Object.values(db.tasks || {})) {
      if (t.status !== 'pending' && t.status !== 'in_progress') continue;
      const age = now - new Date(t.created_at).getTime();
      if (age < TIMEOUT_MS) continue;

      const elapsedH = Math.round(age / 3600000);

      // Notify exactly once — no duplicate noise.
      if (!_notifiedOnce.has(t.task_id)) {
        _notifiedOnce.add(t.task_id);

        // Archive task with full context for traceability.
        archive.archive('tasks', t.task_id, {
          sender_uid: t.sender_uid,
          sender_name: t.sender_name,
          receiver_uid: t.receiver_uid,
          content: t.content,
          status: t.status,
          priority: t.priority,
          retry_count: t.retry_count || 0,
          created_at: t.created_at,
          elapsed_hours: elapsedH,
          timeout_reason: 'Exceeded 24h timeout',
        });

        // Mark exhausted so it's removed from active queue.
        storeRef.updateTaskStatus(t.task_id, 'exhausted',
          'Timed out after ' + elapsedH + 'h — archived. Traceable via archive.');

        // Single notification callback.
        if (onTimeout) onTimeout(t);
      }
    }
  } catch {}
}

module.exports = { start, stop, TIMEOUT_MS };
