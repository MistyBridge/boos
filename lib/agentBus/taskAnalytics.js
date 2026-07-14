// Task type analytics — tracks capability distribution and suggests recruitment.
//
// Sprint 8 #73: PM agent auto-detects frequent task types and suggests
// recruiting a dedicated specialist via HR Agent when threshold exceeded.
//
// Design:
//   - In-memory sliding window (1 hour), no persistence needed.
//   - Hook into queue.sendTask to track each task's required_capabilities.
//   - When a capability appears >= THRESHOLD times in the window, emit event.
//   - PM's PTY receives a recruitment suggestion.

'use strict';

const EventEmitter = require('events');

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const THRESHOLD = 5;              // same capability 5+ times → alert

const analyticsEvents = new EventEmitter();
analyticsEvents.setMaxListeners(50);

// Ring buffer of { capabilities, timestamp } entries.
const _history = [];
const _alerted = new Set(); // capabilities that already triggered alert this window

function track(capabilities) {
  if (!capabilities || capabilities.length === 0) return;

  const now = Date.now();
  _history.push({ caps: [...capabilities], ts: now });

  // Purge expired entries.
  const cutoff = now - WINDOW_MS;
  while (_history.length > 0 && _history[0].ts < cutoff) {
    _history.shift();
  }
  // Also purge stale alerts.
  for (const cap of _alerted) {
    const count = _history.filter((h) => h.caps.includes(cap)).length;
    if (count < THRESHOLD) _alerted.delete(cap);
  }

  // Check thresholds.
  for (const cap of capabilities) {
    if (_alerted.has(cap)) continue;
    const count = _history.filter((h) => h.caps.includes(cap)).length;
    if (count >= THRESHOLD) {
      _alerted.add(cap);
      analyticsEvents.emit('recruitment_suggested', {
        capability: cap,
        count,
        windowMs: WINDOW_MS,
        threshold: THRESHOLD,
      });
    }
  }
}

function getHotCapabilities(minCount) {
  const min = minCount || 1;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const recent = _history.filter((h) => h.ts >= cutoff);

  const counts = new Map();
  for (const entry of recent) {
    for (const cap of entry.caps) {
      counts.set(cap, (counts.get(cap) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= min)
    .sort(([, a], [, b]) => b - a)
    .map(([cap, count]) => ({ capability: cap, count, windowMs: WINDOW_MS }));
}

function getStats() {
  return {
    totalTracked: _history.length,
    hotCapabilities: getHotCapabilities(1),
    alertedCapabilities: [..._alerted],
    threshold: THRESHOLD,
    windowMs: WINDOW_MS,
  };
}

// Hook into queue.sendTask — call this after task creation.
function onTaskSent(task) {
  const caps = task.required_capabilities || [];
  if (caps.length > 0) track(caps);
}

module.exports = {
  track,
  getHotCapabilities,
  getStats,
  onTaskSent,
  analyticsEvents,
  THRESHOLD,
  WINDOW_MS,
};
