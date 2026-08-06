// DAG task timeout scanner — Sprint 36.
//
// Periodic scan for DAG tasks stuck in active/submitted > 24h.
// DAG tasks are still in the shared agent-bus.json (unlike regular
// tasks which moved to per-agent inbox files in Sprint 35).
//
// On timeout:
//   - active > 24h → auto-escalate to PM
//   - submitted > 24h → auto-escalate (reviewer may be unresponsive)

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const { withFileLock } = require('../atomicJson');
const store = require('./store');

const TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 120_000;  // scan every 2min (DAG scans are heavier)

let _timer = null;
const _notifiedOnce = new Set();

function start(onTimeout) {
  if (_timer) return;
  _timer = setInterval(() => _scan(onTimeout), SCAN_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function _scan(onTimeout) {
  try {
    await withFileLock(store.DB_PATH, async () => {
      const fs = require('fs');
      const db = JSON.parse(fs.readFileSync(store.DB_PATH, 'utf-8'));
      const now = Date.now();
      let modified = false;

      // Only scan active DAGs (not draft/cancelled/completed).
      const activeDags = Object.values(db.dags || {}).filter(
        (d) => d.status === 'active'
      );

      for (const task of Object.values(db.dag_tasks || {})) {
        // Only scan tasks in active DAGs with stuck statuses.
        if (task.status !== 'active' && task.status !== 'submitted') continue;
        if (!activeDags.some((d) => d.dag_id === task.dag_id)) continue;

        const createdAt = task.created_at || task.activated_at;
        if (!createdAt) continue;
        const age = now - new Date(createdAt).getTime();
        if (age < TIMEOUT_MS) continue;

        const elapsedH = Math.round(age / 3600000);

        if (!_notifiedOnce.has(task.task_id)) {
          _notifiedOnce.add(task.task_id);

          // Mark as escalated so PM sees it.
          task.status = 'escalated';
          task.escalated_at = new Date().toISOString();
          task.escalation_reason =
            `Timed out after ${elapsedH}h in ${task.status} status`;
          modified = true;

          console.log(
            '[dagTimeout] escalated',
            task.task_id,
            `(${task.title || 'untitled'})`,
            '- stuck for', elapsedH, 'hours'
          );

          if (onTimeout) {
            try {  onTimeout(task);  } catch (e) { errReport.report("dagTimeout", "onTimeout", e); }
          }
        }
      }

      if (modified) {
        const { atomicWriteJson } = require('../atomicJson');
        const errReport = require("../errorReport");
        await atomicWriteJson(store.DB_PATH, db);
      }
    });
  } catch (e) {
    // Silently skip if file is locked or missing.
    if (e.code !== 'ENOENT') {
      console.warn('[dagTimeout] scan error:', e.message);
    }
  }
}

module.exports = { start, stop, TIMEOUT_MS };
