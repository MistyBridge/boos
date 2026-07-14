// Remote · expose this backend over a public tunnel URL so the same
// frontend can be loaded from a phone / another laptop / wherever.
// All API + WS calls are gated by a token the user sets here; the
// share URL embeds it (?token=…) so the remote browser captures it
// on first arrival and stashes it in localStorage.
//
// Layout mirrors ConfigurePage: .settings-scroll wrapper → Section →
// .config-grid → .field rows with label + content. No bespoke cards.

import { html } from '../html.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../api.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { setToast } from '../toast.js';
import { boosConfirm, boosPrompt } from '../dialog.js';
import { IconCopy, IconRecycle, IconExternal, IconInfo, IconPencil, IconClose, IconCloudflareColor, IconMicrosoftColor } from '../icons.js';
import { T } from '../i18n.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';

function genToken() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setToast('已复制', 'ok');
  } catch {
    setToast('复制失败 · 请手动选择 + Ctrl+C', 'error');
  }
}

function shareUrl(tunnelUrl, token) {
  if (!tunnelUrl || !token) return '';
  try {
    const u = new URL(tunnelUrl);
    u.searchParams.set('token', token);
    return u.toString();
  } catch { return ''; }
}

function Section({ title, meta, children }) {
  return html`
    <section class="settings-section">
      <header class="settings-section-head">
        <h2 class="settings-section-title">${title}</h2>
        ${meta ? html`<p class="settings-section-meta">${meta}</p>` : null}
      </header>
      <div class="settings-section-body">${children}</div>
    </section>`;
}

function DeviceRow({ d, kind, onApprove, onReject, onRevoke, onRename, onDelete }) {
  const lastSeen = d.lastSeen ? fmtAgo(d.lastSeen) : '—';
  const ipShort = d.ip ? d.ip.split(',')[0].trim() : null;
  return html`
    <div class=${`remote-device is-${kind}`}>
      <div class="remote-device-main">
        <div class="remote-device-label">
          ${d.code ? html`<code class="remote-device-code" title="将此码与请求设备上显示的代码进行比对">${d.code}</code>` : null}
          <span class="remote-device-name">${d.label || '未知设备'}</span>
          ${kind === 'approved' ? html`
            <button class="icon-btn" title="重命名" onClick=${onRename}><${IconPencil} /></button>
          ` : null}
        </div>
        <div class="remote-device-meta">
          ${ipShort ? html`<span class="mono">${ipShort}</span> · ` : null}
          <span>活跃于 ${lastSeen}</span>
          ${d.userAgent ? html` · <span class="remote-device-ua" title=${d.userAgent}>${d.userAgent.slice(0, 60)}${d.userAgent.length > 60 ? '…' : ''}</span>` : null}
        </div>
      </div>
      <div class="remote-device-actions">
        ${kind === 'pending' ? html`
          <button class="action primary small" onClick=${onApprove}>批准</button>
          <button class="action subtle small" onClick=${onReject}>拒绝</button>
        ` : null}
        ${kind === 'approved' ? html`
          <button class="action subtle danger small" onClick=${onRevoke}><${IconClose} /> 撤销</button>
        ` : null}
        ${kind === 'rejected' ? html`
          <button class="action subtle small" onClick=${onApprove}>重新批准</button>
          <button class="action subtle danger small" onClick=${onDelete}><${IconClose} /> 删除</button>
        ` : null}
      </div>
    </div>`;
}

function ProviderTile({ id, label, hint, icon, selected, disabled, onSelect }) {
  return html`
    <button type="button"
            class=${`provider-tile${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
            aria-pressed=${selected ? 'true' : 'false'}
            disabled=${disabled}
            onClick=${() => !disabled && onSelect(id)}>
      <span class="provider-tile-icon">${icon}</span>
      <span class="provider-tile-body">
        <span class="provider-tile-label">${label}</span>
        ${hint ? html`<span class="provider-tile-hint">${hint}</span>` : null}
      </span>
    </button>`;
}

// Tiny inline row shown under the signed-in Microsoft Dev Tunnel
// status. Displays the persisted (named) tunnel id boos reuses across
// restarts so the public URL stays stable — and lets the user rotate
// it on demand. Reset requires the tunnel to be stopped first; the
// server-side route also enforces this.
function DevtunnelTunnelIdRow({ tunnelId, running, onReset }) {
  if (!tunnelId) {
    return html`
      <div class="tunnel-id-row is-empty">
        <span class="tunnel-id-label">Tunnel id</span>
        <span class="tunnel-id-value-empty">暂无 · 下次启动时生成</span>
      </div>`;
  }
  return html`
    <div class="tunnel-id-row">
      <span class="tunnel-id-label">Tunnel id</span>
      <code class="tunnel-id-value" title="稳定的公共 URL 标识符 · 跨重启复用">${tunnelId}</code>
      <button type="button" class="action subtle small tunnel-id-reset"
              disabled=${running}
              title=${running ? '请先停止隧道' : '生成新的隧道 ID（公共 URL 将改变）'}
              onClick=${onReset}>
        <${IconRecycle} /> 重置
      </button>
    </div>`;
}

function ProviderStatus({ id, info, onInstall, onLogin, loggingIn }) {
  if (!info) return html`<span class="provider-status-muted">检测中…</span>`;
  if (!info.installed) {
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-warn">
          <span class="provider-status-dot is-warn"></span> 未安装
        </span>
        <button type="button" class="action small" onClick=${onInstall}>
          通过 winget 安装
        </button>
      </div>`;
  }
  if (id !== 'devtunnel') {
    // Cloudflare quick tunnel · no account state, just version.
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-ok">
          <span class="provider-status-dot is-ok"></span> 就绪 · 匿名
        </span>
        ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
      </div>`;
  }
  // devtunnel · signed-in / signed-out states each get their own row.
  if (!info.loggedIn) {
    // While a sign-in flow is in flight the signin-card below this
    // row carries its own header + spinner + cancel button. Showing
    // a second "Signing in…" CTA here is just noise — collapse the
    // whole signed-out block down to a thin status line until the
    // card resolves one way or the other.
    if (loggingIn) {
      return html`
        <div class="provider-status">
          <span class="provider-status-state">
            <span class="provider-status-dot"></span> 登录中…
          </span>
          ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
        </div>`;
    }
    return html`
      <div class="provider-status">
        <span class="provider-status-state is-warn">
          <span class="provider-status-dot is-warn"></span> 未登录
        </span>
        ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
        <button type="button" class="btn-signin-microsoft provider-status-signin" onClick=${onLogin}>
          <${IconMicrosoftColor} size=${18} />
          <span>Microsoft 账号登录</span>
        </button>
      </div>`;
  }
  return html`
    <div class="provider-status">
      <span class="provider-status-state is-ok">
        <span class="provider-status-dot is-ok"></span> 已登录
      </span>
      <span class="provider-status-user">${info.user}</span>
      ${info.version ? html`<span class="provider-status-version">${info.version}</span>` : null}
      <button type="button" class="action subtle small provider-status-switch" onClick=${onLogin}>
        切换
      </button>
    </div>`;
}

// Device-code login panel. Shown when a `devtunnel user login -d` flow
// is in flight or just finished. The user clicks Open, signs in on
// microsoft.com, and we flip to "Signed in" automatically when the
// child exits 0 (the probe cache gets invalidated on exit).
function DevtunnelLoginPanel({ login, onCancel, onDismiss, onRetry }) {
  if (!login) return null;
  const { status, url, code, error, user, lines } = login;
  const running  = status === 'running';
  const done     = status === 'done';
  const failed   = status === 'error';
  const canceled = status === 'canceled';
  const host = (() => { try { return new URL(url).host; } catch { return url || ''; } })();
  return html`
    <div class=${`signin-card is-${status}`}>
      ${running ? html`
        <div class="signin-card-header">
          <span class="signin-card-spinner" aria-hidden="true"></span>
          <span class="signin-card-eyebrow">正在登录 Microsoft 账号</span>
          <button type="button" class="signin-card-cancel" onClick=${onCancel} title="取消登录">
            <${IconClose} /> 取消
          </button>
        </div>
        <div class="signin-card-code-block">
          <span class="signin-card-code-label">设备代码</span>
          <div class="signin-card-code-row">
            ${code ? html`
              <code class="signin-card-code">${code}</code>
              <button type="button" class="action subtle small signin-card-code-copy"
                      title="复制代码" onClick=${() => copy(code)}>
                <${IconCopy} />
              </button>
            ` : html`<span class="signin-card-code-pending">生成中…</span>`}
          </div>
        </div>
        <ol class="signin-card-steps">
          <li>
            ${url ? html`
              <a class="signin-card-open" href=${url} target="_blank" rel="noreferrer noopener">
                <${IconExternal} /> 打开 <span class="signin-card-host">${host}</span>
              </a>
            ` : html`<span class="signin-card-step-muted">等待登录 URL…</span>`}
          </li>
          <li>粘贴上方显示的设备代码。</li>
          <li>选择账号并批准 — 此页面将自动跳转。</li>
        </ol>
      ` : null}
      ${done ? html`
        <div class="signin-card-result is-ok">
          <span class="signin-card-result-icon" aria-hidden="true">✓</span>
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">已登录</div>
            <div class="signin-card-result-meta">
              ${user ? html`已登录为 <code>${user}</code> · ` : ''}你现在可以启动隧道了。
            </div>
          </div>
          <button type="button" class="action subtle small" onClick=${onDismiss}>关闭</button>
        </div>
      ` : null}
      ${failed ? html`
        <div class="signin-card-result is-error">
          <span class="signin-card-result-icon" aria-hidden="true">!</span>
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">登录失败</div>
            <div class="signin-card-result-meta">${error || 'devtunnel 退出时发生错误。'}</div>
          </div>
          <div class="signin-card-result-actions">
            <button type="button" class="action small" onClick=${onRetry}>重试</button>
            <button type="button" class="action subtle small" onClick=${onDismiss}>关闭</button>
          </div>
        </div>
      ` : null}
      ${canceled ? html`
        <div class="signin-card-result is-muted">
          <div class="signin-card-result-body">
            <div class="signin-card-result-title">登录已取消</div>
          </div>
          <div class="signin-card-result-actions">
            <button type="button" class="action small" onClick=${onRetry}>重试</button>
            <button type="button" class="action subtle small" onClick=${onDismiss}>关闭</button>
          </div>
        </div>
      ` : null}
      ${lines && lines.length ? html`
        <details class="signin-card-log">
          <summary>CLI 输出 · ${lines.length} 行</summary>
          <pre>${lines.join('\n')}</pre>
        </details>
      ` : null}
    </div>`;
}

export function RemotePage() {
  clockTick.value; // re-tick fmtAgo "last seen" labels
  // Hydrate from a localStorage cache so the page renders the same
  // shape it had at the end of the previous visit — provider tiles,
  // signed-in state, tunnel id, share URL — instead of empty / placeholder
  // chrome that fills in after the slow /api/tunnel/status round-trip
  // (700ms+ on a cold probe). The cached snapshot is overwritten by
  // refresh() the moment the live response lands.
  const cachedStatus = (() => {
    try {
      const raw = localStorage.getItem('boos.remote-status-cache');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();
  const [status, setStatus] = useState(cachedStatus);
  const [provider, setProvider] = useState(() => {
    if (cachedStatus?.running && cachedStatus?.provider) return cachedStatus.provider;
    if (cachedStatus?.providers?.devtunnel?.installed) return 'devtunnel';
    if (cachedStatus?.providers?.cloudflared?.installed) return 'cloudflared';
    return 'devtunnel';
  });
  const [token, setTokenLocal] = useState(cachedStatus?.token || '');
  const [busy, setBusy] = useState(false);
  const [deviceList, setDeviceList] = useState([]);
  const pollRef = useRef(null);

  // Tunnel status and the device list are fetched INDEPENDENTLY, not as a
  // bundled Promise.all. /api/tunnel/status can lag behind a cold provider
  // probe; the device list is cheap. Coupling them made the (fast) device
  // list wait on the (slow) status round-trip, so the whole page appeared
  // to refresh in one delayed lump. Now each updates its own state the
  // moment its own fetch lands.
  async function refreshStatus() {
    try {
      const s = await api('GET', '/api/tunnel/status');
      setStatus(s);
      setTokenLocal((cur) => cur || s.token || '');
      setProvider((cur) => {
        if (s.running && s.provider) return s.provider;
        if (cur) return cur;
        if (s.providers?.devtunnel?.installed) return 'devtunnel';
        if (s.providers?.cloudflared?.installed) return 'cloudflared';
        return cur || 'devtunnel';
      });
      // Snapshot for the next mount. Skip the per-call `log` so the
      // cache stays small.
      try {
        localStorage.setItem('boos.remote-status-cache', JSON.stringify({
          ...s, log: undefined,
        }));
      } catch {}
    } catch (e) { setToast(`状态加载失败 · ${e.message}`, 'error'); }
  }
  async function refreshDevices() {
    try {
      const devs = await api('GET', '/api/devices');
      setDeviceList(devs.devices || []);
    } catch { /* non-critical — keep the last good list on a transient error */ }
  }
  function refresh() { refreshStatus(); refreshDevices(); }

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 2500);
    return () => clearInterval(pollRef.current);
  }, []);

  async function onApproveDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/approve`); refreshDevices(); setToast('设备已批准', 'ok'); }
    catch (e) { setToast(`批准失败 · ${e.message}`, 'error'); }
  }
  async function onRejectDevice(id) {
    try { await api('POST', `/api/devices/${encodeURIComponent(id)}/reject`); refreshDevices(); setToast('设备已拒绝', 'ok'); }
    catch (e) { setToast(`拒绝失败 · ${e.message}`, 'error'); }
  }
  async function onDeleteDevice(d) {
    const ok = await boosConfirm(
      `注销设备「${d.label || d.id}」？该设备将从列表中消失。如果再次尝试，将作为新的待批准请求重新出现。`,
      { title: '注销设备', okLabel: '删除', danger: true },
    );
    if (!ok) return;
    try { await api('DELETE', `/api/devices/${encodeURIComponent(d.id)}`); refreshDevices(); setToast('设备已删除', 'ok'); }
    catch (e) { setToast(`删除失败 · ${e.message}`, 'error'); }
  }
  async function onRevokeDevice(d) {
    const ok = await boosConfirm(`撤销「${d.label || d.id}」的访问权限？所有打开的标签页将立即失去访问。`, {
      title: '撤销设备', okLabel: '撤销', danger: true,
    });
    if (!ok) return;
    try { await api('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`); refreshDevices(); setToast('访问已撤销', 'ok'); }
    catch (e) { setToast(`撤销失败 · ${e.message}`, 'error'); }
  }
  async function onRenameDevice(d) {
    const next = await boosPrompt('重命名设备', d.label || '', { okLabel: '保存' });
    if (next === null) return;
    try { await api('PUT', `/api/devices/${encodeURIComponent(d.id)}`, { label: next.trim() }); refreshDevices(); }
    catch (e) { setToast(`重命名失败 · ${e.message}`, 'error'); }
  }

  async function onStart() {
    setBusy(true);
    try {
      // Auto-mint a token if the user hasn't generated one yet — the
      // registration token is now an implementation detail of starting
      // a tunnel rather than a separate setup step.
      let tok = token;
      if (!tok || tok.length < 8) {
        tok = genToken();
        setTokenLocal(tok);
        try { await api('POST', '/api/tunnel/token', { token: tok }); }
        catch (e) { /* the start call below will fail too — surface that */ }
      }
      const s = await api('POST', '/api/tunnel/start', { provider, token: tok });
      setStatus(s);
      setToast(s.url ? '隧道已上线' : '隧道启动中 · URL 即将出现', 'ok');
    } catch (e) {
      setToast(`启动失败 · ${e.message}`, 'error');
    } finally { setBusy(false); }
  }
  async function onStop() {
    setBusy(true);
    try {
      const s = await api('POST', '/api/tunnel/stop');
      setStatus(s);
      setToast('隧道已停止', 'ok');
    } catch (e) { setToast(`停止失败 · ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }
  // Generate is the only path that mutates the token now — local React
  // state and the server's stored token stay in lockstep, so the Share
  // URL preview always embeds a token the server will accept. (The
  // previous design had a separate Save step; users would Generate +
  // copy the URL without saving, then the remote would 401 because
  // its embedded token didn't match what the server still had.)
  async function onGenerateToken() {
    const fresh = genToken();
    setTokenLocal(fresh);
    try {
      // When auto-start is on the token must be PERSISTED, else the
      // rotated token is lost on the next backend restart and every
      // share URL built from it 401s. Route through the persisting
      // endpoint in that case; otherwise the in-memory-only token
      // endpoint is enough.
      const s = status?.autoStart
        ? await api('POST', '/api/tunnel/autostart', { autoStart: true, provider, token: fresh })
        : await api('POST', '/api/tunnel/token', { token: fresh });
      setStatus(s);
      setToast('新令牌已生效', 'ok');
    } catch (e) { setToast(`令牌保存失败 · ${e.message}`, 'error'); }
  }
  // Persist (or clear) the auto-start preference. On enable with no
  // token yet, mint one first so the backend has something to reuse on
  // its next startup. Approved devices keep working regardless of the
  // token — it only gates NEW device registration.
  async function onToggleAutoStart(next) {
    setBusy(true);
    try {
      let tok = token;
      if (next && (!tok || tok.length < 8)) { tok = genToken(); setTokenLocal(tok); }
      const s = await api('POST', '/api/tunnel/autostart',
        next ? { autoStart: true, provider, token: tok } : { autoStart: false });
      setStatus(s);
      setToast(next ? '自动启动已开启 · boos 启动时自动上线' : '自动启动已关闭', 'ok');
    } catch (e) {
      setToast(`自动启动${next ? '启用' : '禁用'}失败 · ${e.message}`, 'error');
    } finally { setBusy(false); }
  }
  async function onInstall(p) {
    const ok = await boosConfirm(`通过 winget 安装 ${p}？将在后台运行 — 约 30 秒后刷新。`, {
      title: '安装隧道提供商', okLabel: '安装',
    });
    if (!ok) return;
    try {
      await api('POST', '/api/tunnel/install', { provider: p });
      setToast(`${p} 安装正在后台运行 · 请稍后查看`, 'ok');
    } catch (e) { setToast(`安装失败 · ${e.message}`, 'error'); }
  }
  function onLogin(p) {
    if (p !== 'devtunnel') return;
    // Kick off `devtunnel user login -d` on the host and let the
    // panel below render the device code + URL. /status polling
    // (every 2.5s) picks up the eventual outcome.
    (async () => {
      try {
        const r = await api('POST', '/api/tunnel/devtunnel/login', { mode: 'microsoft' });
        if (r?.login) setStatus((cur) => cur ? { ...cur, login: r.login } : cur);
        refresh();
      } catch (e) { setToast(`登录失败 · ${e.message}`, 'error'); }
    })();
  }
  async function onLoginCancel() {
    try { await api('POST', '/api/tunnel/devtunnel/login/cancel'); refresh(); }
    catch (e) { setToast(`取消失败 · ${e.message}`, 'error'); }
  }
  async function onLoginDismiss() {
    try { await api('POST', '/api/tunnel/devtunnel/login/dismiss'); refresh(); }
    catch (e) { setToast(`关闭失败 · ${e.message}`, 'error'); }
  }
  async function onResetDevtunnelId() {
    const ok = await boosConfirm(
      `生成新的隧道 ID？公共 URL 会改变 — 所有已批准的远程设备需要在新 URL 上重新注册。现有分享链接将失效。`,
      { title: '重置 Microsoft Dev Tunnel ID', okLabel: '重置', danger: true },
    );
    if (!ok) return;
    try {
      await api('POST', '/api/tunnel/devtunnel/reset');
      refresh();
      setToast('隧道 ID 已重置 · 下次启动时生成新 ID', 'ok');
    } catch (e) { setToast(`重置失败 · ${e.message}`, 'error'); }
  }

  const running = status?.running;
  const url     = status?.url;
  const share   = shareUrl(url, token);
  const log     = status?.log || [];
  const cf      = status?.providers?.cloudflared;
  const dt      = status?.providers?.devtunnel;
  const dtLogin = status?.login || null;
  const dtLoggingIn = dtLogin?.status === 'running';
  // First /api/tunnel/status round-trip is the slow one — even with
  // the 30s server-side cache + parallel probe, a cold call shells
  // out and adds ~700ms. We render the full page immediately and let
  // individual fields show their own "probing…" state instead of
  // gating the whole panel behind a centered spinner.

  return html`
    <${PageTitleBar} title="远程访问" />
    <div class="settings-scroll">

      <${Section}
        title="连接"
        meta=${html`选择隧道使用的 CLI。`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">提供商</span>
            <div class="provider-tile-row">
              <${ProviderTile} id="devtunnel" label="Microsoft Dev Tunnel"
                hint="需要登录"
                icon=${html`<${IconMicrosoftColor} size=${32} />`}
                selected=${provider === 'devtunnel'}
                disabled=${running}
                onSelect=${setProvider} />
              <${ProviderTile} id="cloudflared" label="Cloudflare Tunnel"
                hint="匿名 · 无需登录"
                icon=${html`<${IconCloudflareColor} size=${32} />`}
                selected=${provider === 'cloudflared'}
                disabled=${running}
                onSelect=${setProvider} />
            </div>
            ${running ? html`<span class="hint">停止隧道以切换提供商。</span>` : null}
          </div>
          ${provider === 'devtunnel' ? html`
            <div class="field">
              <span class="label">Microsoft Dev Tunnel</span>
              <div class="remote-status-line">
                <${ProviderStatus} id="devtunnel" info=${dt}
                  onInstall=${() => onInstall('devtunnel')}
                  onLogin=${() => onLogin('devtunnel')}
                  loggingIn=${dtLoggingIn} />
              </div>
              ${dtLogin ? html`
                <${DevtunnelLoginPanel}
                  login=${dtLogin}
                  onCancel=${onLoginCancel}
                  onDismiss=${onLoginDismiss}
                  onRetry=${() => onLogin('devtunnel')} />
              ` : null}
              ${dt?.loggedIn ? html`
                <${DevtunnelTunnelIdRow}
                  tunnelId=${status?.tunnelId}
                  running=${running && status?.provider === 'devtunnel'}
                  onReset=${onResetDevtunnelId} />
              ` : null}
            </div>
          ` : null}
          ${provider === 'cloudflared' ? html`
            <div class="field">
              <span class="label">Cloudflare Tunnel</span>
              <div class="remote-status-line">
                <${ProviderStatus} id="cloudflared" info=${cf}
                  onInstall=${() => onInstall('cloudflared')} />
              </div>
            </div>
          ` : null}
        </div>
      </${Section}>

      <${Section}
        title="隧道"
        meta=${running
          ? html`提供商 <code>${status?.provider}</code> · 启动于 ${new Date(status.startedAt).toLocaleTimeString()}`
          : html`未运行。`}>
        <div class="tunnel-autostart">
          <label class="tunnel-autostart-row">
            <input type="checkbox" checked=${!!status?.autoStart} disabled=${busy}
                   onChange=${(e) => onToggleAutoStart(e.target.checked)} />
            <span class="tunnel-autostart-label">boos 启动时自动启动此隧道</span>
          </label>
          ${status?.autoStart && provider === 'cloudflared' ? html`
            <span class="hint tunnel-autostart-hint">
              Cloudflare 快速隧道每次启动获取新 URL — 分享链接将在重启后失效，已批准设备需重新注册。如需稳定 URL，请使用 Microsoft Dev Tunnel。
            </span>` : null}
        </div>
        ${!running ? html`
          <div class="tunnel-hero">
            <div class="tunnel-hero-body">
              <div class="tunnel-hero-title">此后端上线</div>
              <div class="tunnel-hero-meta">
                boos 将启动
                <code>${provider === 'devtunnel' ? 'devtunnel' : 'cloudflared'}</code>
                并等待其输出公共 URL。
              </div>
            </div>
            <button type="button" class="action tunnel-hero-cta"
                    disabled=${busy}
                    onClick=${onStart}>
              <${IconExternal} /> ${busy ? '启动中…' : '启动隧道'}
            </button>
          </div>
        ` : html`
          <div class="tunnel-live">
            <div class="tunnel-live-head">
              <span class="tunnel-live-state">
                <span class="tunnel-live-dot"></span>
                运行中
              </span>
              <span class="tunnel-live-divider">·</span>
              <span class="tunnel-live-provider">${status?.provider === 'devtunnel' ? 'Microsoft Dev Tunnel' : 'Cloudflare Tunnel'}</span>
              <span class="tunnel-live-divider">·</span>
              <span class="tunnel-live-meta">自 ${new Date(status.startedAt).toLocaleTimeString()}</span>
              <button type="button" class="tunnel-stop-link"
                      disabled=${busy}
                      onClick=${onStop}>
                <${IconClose} /> ${busy ? '停止中…' : '停止隧道'}
              </button>
            </div>
            ${url ? html`
              <div class="tunnel-share">
                <div class="tunnel-share-label">分享 URL</div>
                <div class="tunnel-share-url">
                  <code class="tunnel-share-value">${share}</code>
                  <div class="tunnel-share-actions">
                    <button type="button" class="action small" onClick=${() => copy(share)}>
                      <${IconCopy} /> 复制
                    </button>
                    <a class="action small" href=${share} target="_blank" rel="noreferrer noopener">
                      <${IconExternal} /> 打开
                    </a>
                  </div>
                </div>
                <div class="tunnel-share-hint">
                  发送到远程设备 · 令牌已嵌入，首次到达时从 URL 中剥离。
                </div>
              </div>
            ` : html`
              <div class="tunnel-share is-waiting">
                <div class="signin-card-spinner" aria-hidden="true"></div>
                <span>等待 CLI 输出公共 URL…</span>
              </div>
            `}
            ${log.length ? html`
              <details class="remote-log tunnel-log">
                <summary>CLI 日志 · ${log.length} 行</summary>
                <pre>${log.join('\n')}</pre>
              </details>
            ` : null}
          </div>
        `}
      </${Section}>

      <${Section}
        title="注册令牌"
        meta=${html`自动生成。仅用于注册新设备 — 已批准设备在轮换后仍可正常使用。`}>
        <div class="config-grid">
          <div class="field">
            <span class="label">令牌</span>
            <div class="remote-token-row">
              <input type="text" class="input remote-token-input"
                     readonly
                     placeholder="首次启动隧道时自动生成"
                     value=${token} />
              <button type="button" class="action" title="生成新令牌（使未使用的分享 URL 失效）"
                      onClick=${onGenerateToken}>
                <${IconRecycle} /> ${token ? '轮换' : '生成'}
              </button>
              <button type="button" class="action"
                      disabled=${!token}
                      onClick=${() => copy(token)}>
                <${IconCopy} /> 复制
              </button>
            </div>
            <span class="hint">
              ${(!status?.token && !token)
                ? html`暂无令牌 — 首次启动隧道时自动生成。`
                : html`已激活。轮换后旧的分享 URL 立即失效，但不会踢出已批准的设备。`}
            </span>
          </div>
        </div>
      </${Section}>

      <${Section}
        title="设备"
        meta=${html`每个新设备只需批准一次。`}>
        ${(() => {
          const pending  = deviceList.filter((d) => d.status === 'pending');
          const approved = deviceList.filter((d) => d.status === 'approved');
          const rejected = deviceList.filter((d) => d.status === 'rejected');
          if (!deviceList.length) {
            return html`<p class="remote-empty">暂无设备。将分享 URL 发送到手机或其他电脑以添加第一个设备。</p>`;
          }
          return html`
            <div class="remote-devices">
              ${pending.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">待批准</span>
                    <span class="remote-devices-group-count">${pending.length}</span>
                  </div>
                  ${pending.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="pending"
                    onApprove=${() => onApproveDevice(d.id)}
                    onReject=${() => onRejectDevice(d.id)} />`)}
                </div>
              ` : null}
              ${approved.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">已批准</span>
                    <span class="remote-devices-group-count">${approved.length}</span>
                  </div>
                  ${approved.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="approved"
                    onRename=${() => onRenameDevice(d)}
                    onRevoke=${() => onRevokeDevice(d)} />`)}
                </div>
              ` : null}
              ${rejected.length ? html`
                <div class="remote-devices-group">
                  <div class="remote-devices-group-head">
                    <span class="remote-devices-group-title">已拒绝</span>
                    <span class="remote-devices-group-count">${rejected.length}</span>
                    <span class="remote-devices-group-hint">拒绝后 1 小时自动清除</span>
                  </div>
                  ${rejected.map((d) => html`<${DeviceRow}
                    key=${d.id} d=${d} kind="rejected"
                    onApprove=${() => onApproveDevice(d.id)}
                    onDelete=${() => onDeleteDevice(d)} />`)}
                </div>
              ` : null}
            </div>`;
        })()}
      </${Section}>

    </div>`;
}
