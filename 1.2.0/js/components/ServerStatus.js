import { html } from '../html.js';
import { serverHealth } from '../state.js';
import { T } from '../i18n.js';

export function ServerStatus() {
  const h = serverHealth.value;
  const view = {
    online:     { text: h.version ? T.serverStatus.online(h.version) : T.health.online,
                  title: T.serverStatus.ok(h.pid, h.version) },
    offline:    { text: T.serverStatus.offline, title: T.serverStatus.unreachable(h.error) },
    connecting: { text: T.serverStatus.connecting, title: T.serverStatus.checking },
  }[h.state] || { text: h.state, title: h.state };

  return html`
    <span class="server-status" data-state=${h.state} title=${view.title}>
      <span class="status-pulse" aria-hidden="true"></span>
      <span class="server-status-label">${view.text}</span>
    </span>`;
}
