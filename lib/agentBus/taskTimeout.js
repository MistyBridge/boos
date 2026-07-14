// Task timeout scanner — Sprint 8 #61.
//
// Periodic scan for tasks stuck in pending/in_progress > 30min.
// Timed-out tasks are cancelled and notification events emitted.

'use strict';

const TIMEOUT_MS = 30 * 60 * 1000;
const SCAN_INTERVAL_MS = 60_000;

let _timer = null;

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
    for (const t of Object.values(db.tasks || {})) {
      if (t.status !== 'pending' && t.status !== 'in_progress') continue;
      if (now - new Date(t.created_at).getTime() < TIMEOUT_MS) continue;
      storeRef.updateTaskStatus(t.task_id, 'cancelled',
        'Task timed out after ' + Math.round((now - new Date(t.created_at).getTime()) / 60000) + ' minutes');
      if (onTimeout) onTimeout(t);
    }
  } catch {}
}

module.exports = { start, stop, TIMEOUT_MS };
