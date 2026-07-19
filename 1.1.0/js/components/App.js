import { html } from '../html.js';
import { activeTab, selectTab, sessions, workspaceAgentActivity, pendingDirty } from '../state.js';
import { useEffect } from 'preact/hooks';
import { isRemoteAccess } from '../backend.js';
import { T } from '../i18n.js';
import { PageTitleBar } from './PageTitleBar.js';
import { Sidebar } from './Sidebar.js';
import { Toast } from './Toast.js';
import { DialogHost } from './DialogHost.js';
import { HealthOverlay } from './HealthOverlay.js';
import { PendingApprovalOverlay } from './PendingApprovalOverlay.js';
import { RestartOverlay } from './RestartOverlay.js';
import { MobileNavFab } from './MobileNavFab.js';
import { isMobile, mobileDrawerOpen } from '../state.js';
import { subscribeAgentEvents } from '../api.js';
import { SessionsPage } from '../pages/SessionsPage.js';
import { WorkspacePage } from '../pages/WorkspacePage.js';
import { LaunchPage } from '../pages/LaunchPage.js';
import { ConfigurePage } from '../pages/ConfigurePage.js';
import { RemotePage } from '../pages/RemotePage.js';
import { AboutPage } from '../pages/AboutPage.js';
import { DecisionsPage } from '../pages/DecisionsPage.js';

function Panel({ name, children }) {
  const active = activeTab.value === name;
  return html`<section class="tab-panel" data-panel=${name} data-active=${active || null}>${children}</section>`;
}

// Static placeholder for #remote on tunnel-served pages. Remote / device
// / tunnel management is loopback-only — the server returns 403 on
// every relevant endpoint — so even if a user navigates here via URL
// hash we render a clear "host machine only" message instead of a
// broken RemotePage spamming the console.
function RemoteHostOnlyPanel() {
  useEffect(() => {
    // Bounce back to whatever tab they were on before, after a brief
    // moment so the message is readable.
    const t = setTimeout(() => selectTab('sessions'), 2500);
    return () => clearTimeout(t);
  }, []);
  return html`
    <${PageTitleBar} title={T.remote.title} />
    <div class="settings-scroll">
      <p class="remote-empty" style="margin-top:var(--s-6)">
        远程管理仅在主机上可用。
        正在返回会话页面…
      </p>
    </div>`;
}

export function App() {
  const tab = activeTab.value;
  const remoteLocked = tab === 'remote' && isRemoteAccess();
  const mobile = isMobile.value;
  const drawer = mobileDrawerOpen.value;

  // ── Global SSE: bridge agent-bus activity notifications → Sidebar ──
  // Must be mounted at App-level (not WorkspacePage) so Sidebar dots
  // reflect agent activity regardless of which page the user is viewing.
  //
  // Sprint 17 B1 (P0): 50ms debounce + rAF batch merge.
  // Multiple SSE activity events accumulate for 50ms, then flush
  // inside a single requestAnimationFrame — one render per frame max.
  // pendingDirty flag signals downstream that a flush is imminent.
  useEffect(() => {
    let pendingActivity = null;
    let debounceTimer = null;
    let rafHandle = null;

    const flush = () => {
      rafHandle = null;
      if (!pendingActivity) return;
      const entries = Object.entries(pendingActivity);
      if (entries.length === 0) return;

      // Batch-apply workspaceAgentActivity signal (one spread).
      workspaceAgentActivity.value = {
        ...workspaceAgentActivity.value,
        ...pendingActivity,
      };

      // Batch-apply sessions signal (one spread for all sidebar dots).
      const list = sessions.value;
      let changed = false;
      const updated = [...list];
      for (const [sid, act] of entries) {
        const idx = list.findIndex((s) => s.id === sid);
        if (idx >= 0 && list[idx].activity !== act) {
          updated[idx] = { ...updated[idx], activity: act };
          changed = true;
        }
      }
      if (changed) sessions.value = updated;

      pendingActivity = null;
      pendingDirty.value = false;
    };

    const scheduleFlush = () => {
      if (rafHandle === null) {
        rafHandle = requestAnimationFrame(flush);
      }
    };

    const unsub = subscribeAgentEvents((data) => {
      if (!data.sessionId || data.type === 'snapshot' || data.type === 'registry') return;
      const isBusy = data.activity === 'busy' || data.activity === 'woken';
      const nextActivity = isBusy ? 'working' : 'idle';

      if (!pendingActivity) pendingActivity = {};
      pendingActivity[data.sessionId] = nextActivity;
      pendingDirty.value = true;

      // 50ms debounce: reset timer on each event; flush after quiet period.
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        scheduleFlush();
      }, 50);
    });
    return () => {
      unsub();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    };
  }, []);

  return html`
    <div class=${`app${mobile ? ' is-mobile' : ''}${mobile && drawer ? ' drawer-open' : ''}`}>
      <${Sidebar} />
      <main class="main">
        <div class="content">
          ${tab === 'sessions'  ? html`<${Panel} name="sessions"><${SessionsPage}   /></${Panel}>` : null}
          ${tab === 'workspace' ? html`<${Panel} name="workspace"><${WorkspacePage}  /></${Panel}>` : null}
          ${tab === 'launch'    ? html`<${Panel} name="launch"><${LaunchPage}     /></${Panel}>` : null}
          ${tab === 'configure' ? html`<${Panel} name="configure"><${ConfigurePage} /></${Panel}>` : null}
          ${tab === 'remote' && !remoteLocked ? html`<${Panel} name="remote"><${RemotePage} /></${Panel}>` : null}
          ${remoteLocked        ? html`<${Panel} name="remote"><${RemoteHostOnlyPanel} /></${Panel}>` : null}
          ${tab === 'about'     ? html`<${Panel} name="about"><${AboutPage}     /></${Panel}>` : null}
          ${tab === 'decisions' ? html`<${Panel} name="decisions"><${DecisionsPage} /></${Panel}>` : null}
        </div>
      </main>
      <${Toast} />
      <${DialogHost} />
      <${HealthOverlay} />
      <${RestartOverlay} />
      <${PendingApprovalOverlay} />
      <${MobileNavFab} />
    </div>`;
}
