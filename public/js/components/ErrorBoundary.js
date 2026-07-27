// Preact error boundary. Catches render-phase throws and shows a
// fallback UI instead of letting the entire app white-screen.
// Wraps page-level components + TerminalView + Sidebar.

import { Component, h, Fragment } from 'preact';
import { html } from '../html.js';

/**
 * ErrorFallback — rendered when a child component throws.
 * Shows error summary, Retry (remount children), and Refresh page buttons.
 * In dev mode (localhost), the full stack is visible.
 */
function ErrorFallback({ error, componentName, onRetry }) {
  const msg = error?.message || String(error);
  const isDev = typeof location !== 'undefined' &&
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  // Report to console regardless of mode.
  console.error(
    `[boos] ErrorBoundary caught in %c${componentName || 'unknown'}%c:`,
    'font-weight:bold;', '', error
  );

  // Optional OpenViking hook — uncomment and import setToast when wired.
  // try { reportErrorToOpenViking(error, componentName); } catch {}

  return html`
    <div style="display:flex;align-items:center;justify-content:center;padding:var(--s-10) var(--s-6);min-height:200px;">
      <div style="
        background:var(--bg-elev);
        border:1px solid var(--border-soft);
        border-radius:8px;
        padding:var(--s-8) var(--s-8) var(--s-6);
        max-width:480px;
        width:100%;
        text-align:center;
        box-shadow:var(--shadow-md);
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:var(--s-3);
      ">
        <div style="font-size:32px;line-height:1;">⚠</div>
        <h2 style="margin:0;font-size:16px;font-weight:600;color:var(--ink);">
          出现错误
        </h2>
        <p style="margin:0;font-size:13px;color:var(--ink-mid);line-height:1.5;max-width:380px;word-break:break-word;">
          <code style="display:block;padding:8px 12px;background:var(--bg);border:1px solid var(--border-soft);border-radius:4px;font-size:11.5px;margin:0 0 8px;text-align:left;white-space:pre-wrap;max-height:120px;overflow-y:auto;">
            ${msg}
          </code>
          ${componentName ? html`<span style="font-size:11.5px;color:var(--ink-muted);">位置: ${componentName}</span>` : null}
          ${isDev ? html`
            <details style="margin-top:8px;text-align:left;">
              <summary style="cursor:pointer;font-size:11px;color:var(--ink-muted);">完整堆栈</summary>
              <pre style="
                margin:8px 0 0;padding:10px 12px;
                background:var(--bg);border:1px solid var(--border-soft);
                border-radius:4px;font-family:var(--mono);font-size:10.5px;
                line-height:1.5;color:var(--ink-mid);white-space:pre-wrap;
                word-break:break-all;max-height:280px;overflow-y:auto;
              ">${error?.stack || '无堆栈信息'}</pre>
            </details>
          ` : null}
        </p>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button class="action primary" onClick=${onRetry}>重试</button>
          <button class="action subtle"
            onClick=${() => { try { location.reload(); } catch {} }}>
            刷新页面
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Error boundary class component. Preact supports componentDidCatch
 * with the same semantics as React — errors thrown during render are
 * caught here, and the fallback UI replaces the subtree.
 *
 * Usage:
 *   <${ErrorBoundary} name="SessionsPage"><${SessionsPage} /></${ErrorBoundary}>
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  componentDidCatch(error) {
    this.setState({ error });
  }

  render(props, state) {
    if (state.error) {
      return html`
        <${ErrorFallback}
          error=${state.error}
          componentName=${props.name || 'Unknown'}
          onRetry=${() => this.setState({ error: null })}
        />`;
    }
    // Multiple children → wrap in Fragment using Preact's h() directly,
    // bypassing htm. htm's html`<>${children}</>` can call h("", null)
    // when processing arrays, triggering a createElementNS crash.
    const children = props.children;
    if (Array.isArray(children)) {
      return h(Fragment, null, ...children);
    }
    return children;
  }
}
