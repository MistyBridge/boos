// Sprint 29: <time-ago> custom element — self-updating relative time display.
//
// Replaces the clockTick signal pattern where every SessionRow/DecisionCard
// read clockTick.value just to trigger a Preact re-render for fmtAgo().
// Each element manages its own 30s setInterval and updates textContent
// directly via the DOM — no framework re-render, no cascading tree updates.
//
// Usage:
//   <time-ago datetime="1700000000000"></time-ago>
//   <time-ago datetime="${s.lastActiveAt}"></time-ago>
//
// The element handles its own lifecycle: starts timer on connectedCallback,
// cleans up on disconnectedCallback. If the datetime attribute changes,
// observedAttributes triggers an immediate re-format.

import { fmtAgo } from '../util.js';

const UPDATE_MS = 30_000; // 30s — matching the old clockTick minute-boundary

class TimeAgo extends HTMLElement {
  static get observedAttributes() {
    return ['datetime'];
  }

  connectedCallback() {
    this._update();
    this._timer = setInterval(() => this._update(), UPDATE_MS);
  }

  disconnectedCallback() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  attributeChangedCallback(name, _oldVal, _newVal) {
    if (name === 'datetime') this._update();
  }

  _update() {
    const val = this.getAttribute('datetime');
    const ms = val ? parseInt(val, 10) : 0;
    this.textContent = ms > 0 ? fmtAgo(ms) : '';
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('time-ago')) {
  customElements.define('time-ago', TimeAgo);
}
