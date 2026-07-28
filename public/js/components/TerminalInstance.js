// VS Code-style terminal instance lifecycle for a single boos session.
// Owns attach/detach, WebSocket transport, xterm input/output forwarding,
// resize propagation, paste handling, and browser/mobile lifecycle hooks.
//
// Sprint 18 P0 (3-in-1):
//   Task 2 — rAF output batching: WS frames coalesced per animation frame,
//     single xterm.write() per rAF; atlas refresh guarded by output-idle check.
//   Task 3 — Zero signal writes: Terminal code never touches Preact signals.
//     agent_status frames dispatched via onAgentStatus callback.

import { wsBase, getToken, getDeviceId, isRemoteAccess } from '../backend.js';
import { TerminalResizeDebouncer } from './TerminalResizeDebouncer.js';
import { XtermTerminal } from './XtermTerminal.js';

const REMOTE_INPUT_FLUSH_MS = 12;

export class TerminalInstance {
  constructor({ terminalId, cliType, onDisplaced, onReconnecting, onReconnected,
                onAgentStatus }) {
    this.terminalId = terminalId;
    this.cliType = cliType;
    this.onDisplaced = onDisplaced;
    this.onReconnecting = onReconnecting;
    this.onReconnected = onReconnected;
    this.onAgentStatus = onAgentStatus;            // Task 3: callback, not signal
    this.xterm = new XtermTerminal();
    this.ws = null;
    this.host = null;
    this.closedByUs = false;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.everOpened = false;
    this._savedState = null;     // Sprint 29: serialized terminal state for reconnect
    this.manuallyReconnecting = false;
    this.inReplay = false;
    this.replayDepth = 0;
    this.isVisible = false;
    this.lastLayoutDimensions = null;
    this.lastSentDimensions = null;
    this.pendingLayoutFrame = null;
    this.themeRefreshTimer = null;
    this.pendingThemeRefresh = false;
    this.remoteAccess = isRemoteAccess();
    this.pendingInput = '';
    this.inputFlushTimer = null;
    this.disposables = [];
    this.helperTextarea = null;

    // ── Task 2: rAF output batching ──
    this.outputBuffer = [];
    this.outputRafScheduled = false;
    this.lastOutputTime = 0;

    this.resizeDebouncer = new TerminalResizeDebouncer({
      isVisible: () => this.isVisible,
      getXterm: () => this.xterm,
      resizeBoth: (cols, rows) => this._applyResize(cols, rows),
      resizeX: (cols) => this._applyResize(cols, this.xterm.rows),
      resizeY: (rows) => this._applyResize(this.xterm.cols, rows),
    });
    const refreshDisposable = this.xterm.onDidRequestRefreshDimensions(() => {
      this.scheduleLayout({ immediate: this.isVisible });
    });
    this.disposables.push(() => refreshDisposable.dispose());
  }

  attachToElement(host) {
    this.host = host;
    this.xterm.attachToElement(host);
    this._registerColorOscHandlers();
    this._wireXtermEvents();
    this._wireDomLifecycle();
    this.setVisible(this._isHostVisible());
    this._connect();

    if (this.isVisible) this.xterm.focus();
  }

  sendInput(data) {
    this._sendInput(data);
  }

  setCliType(cliType) {
    this.cliType = cliType;
  }

  applyTheme() {
    this.xterm.applyResolvedTheme();
    this.xterm.refresh();
    this._scheduleThemeRefreshForCli();
  }

  focus() {
    this.xterm.focus();
  }

  blur() {
    this.xterm.blur();
  }

  layout(width, height, immediate = false) {
    const layoutDimensions = this._resolveLayoutDimensions(width, height);
    if (!layoutDimensions) return null;

    this.lastLayoutDimensions = layoutDimensions;
    const proposed = this.xterm.proposeDimensions(layoutDimensions.width, layoutDimensions.height);
    if (!proposed) return null;

    this.resizeDebouncer.resize(proposed.cols, proposed.rows, immediate);
    return proposed;
  }

  scheduleLayout(options = {}) {
    const { immediate = false } =
      typeof options === 'boolean' ? { immediate: options } : options;
    if (this.closedByUs) return null;

    if (immediate) {
      this._cancelScheduledLayout();
      return this.layout(undefined, undefined, true);
    }

    if (this.pendingLayoutFrame === null) {
      this.pendingLayoutFrame = requestAnimationFrame(() => {
        this.pendingLayoutFrame = null;
        this.layout();
      });
    }
    return null;
  }

  setVisible(visible) {
    const nextVisible = !!visible;
    const didChange = this.isVisible !== nextVisible;
    this.isVisible = nextVisible;
    this.host?.classList.toggle('active', nextVisible);

    if (nextVisible) {
      this.resizeDebouncer.flush();
      this.scheduleLayout({ immediate: true });
      // CanvasRenderer doesn't need a texture-atlas refresh — a single
      // refresh() after the layout settles is enough.
      if (didChange) {
        requestAnimationFrame(() => {
          if (this.xterm && this.isVisible) this.xterm.refresh();
        });
      }
      if (this.pendingThemeRefresh) {
        this.pendingThemeRefresh = false;
        this._scheduleThemeRefreshForCli();
      }
    }
    return didChange;
  }

  dispose() {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.themeRefreshTimer) clearTimeout(this.themeRefreshTimer);
    this._flushInput();
    if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
    this.inputFlushTimer = null;
    this.themeRefreshTimer = null;
    this.pendingThemeRefresh = false;
    this._cancelScheduledLayout();
    this.resizeDebouncer.dispose();
    for (const dispose of this.disposables.splice(0)) {
      try { dispose(); } catch {}
    }
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.helperTextarea = null;
    this.xterm.dispose();

    // Task 2: drain pending output buffer
    this.outputBuffer = [];
    this.outputRafScheduled = false;
  }

  _connect() {
    const ws = new WebSocket(this._wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.everOpened && this._savedState) {
        // Sprint 29: restore serialized terminal state instead of
        // xterm.reset() which destroyed all visible content. The
        // serialize addon preserves scrollback + cursor + attributes
        // so reconnection is invisible to the user.
        this.xterm.deserializeState(this._savedState);
        this._savedState = null;
      }
      this.everOpened = true;
      this.attempts = 0;
      this.onReconnecting?.(false);
      this.onReconnected?.();
      this.scheduleLayout({ immediate: true });
      this._sendResize(this.xterm.cols, this.xterm.rows, true);
    };

    // ── Task 2: WS onmessage → buffer, not direct xterm.write ──
    // ── Task 3: agent_status → callback, not signal ──
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'output') {
        this._bufferOutput(frame.data, !!frame.replay);
      } else if (frame.type === 'exit') {
        this.xterm.write(`\r\n\x1b[2m[进程已退出 · 退出码 ${frame.code}]\x1b[0m\r\n`);
      } else if (frame.type === 'agent_status') {
        // Task 3: dispatch via callback — zero Preact signal writes here
        this.onAgentStatus?.(frame);
      }
    };
    ws.onclose = (ev) => this._handleClose(ev);
  }

  // ── Task 2: rAF output batching ──

  /** Push WS output data into the rAF-batched buffer. */
  _bufferOutput(data, replay) {
    this.outputBuffer.push({ data, replay });
    this._scheduleOutputFlush();
  }

  /** Schedule a single rAF flush if not already pending. */
  _scheduleOutputFlush() {
    if (this.outputRafScheduled) return;
    this.outputRafScheduled = true;
    requestAnimationFrame(() => {
      this.outputRafScheduled = false;
      this._flushOutputBuffer();
    });
  }

  /** Flush all buffered output as a single xterm.write() call. */
  _flushOutputBuffer() {
    if (this.outputBuffer.length === 0) return;
    this.lastOutputTime = performance.now();

    const chunks = this.outputBuffer;
    this.outputBuffer = [];

    // Coalesce all data into one string — one write per animation frame.
    let hasReplay = false;
    const combined = chunks.map(c => {
      if (c.replay) hasReplay = true;
      return c.data;
    }).join('');

    if (hasReplay) {
      this._beginReplay();
      this.xterm.write(combined, () => {
        this._endReplay();
        // Re-layout after replay to accommodate dimension changes.
        // CanvasRenderer handles repaint natively — no texture atlas needed.
        if (this.isVisible) {
          this.scheduleLayout({ immediate: true });
        }
      });
    } else {
      this.xterm.write(combined);
    }
  }

  _handleClose(ev) {
    if (this.closedByUs) return;
    if (ev && ev.code === 4001) {
      this.onReconnecting?.(false);
      this.onDisplaced?.();
      return;
    }
    if (ev && ev.code === 4404) {
      this.onReconnecting?.(false);
      this.xterm.write('\r\n\x1b[2m[会话已结束]\x1b[0m\r\n');
      return;
    }
    this.attempts++;
    // Sprint 29: serialize terminal state before reconnecting.
    // This lets us restore the full scrollback + cursor + attributes
    // when the WS reopens, avoiding the destructive xterm.reset().
    if (!this._savedState) {
      this._savedState = this.xterm.serializeState();
    }
    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → max 30s.
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    this.xterm.write('\r\n\x1b[2m[连接断开 · 正在重连…]\x1b[0m\r\n');
    this.onReconnecting?.(true, this.attempts, delay);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByUs) this._connect();
    }, delay);
  }

  /** Force an immediate reconnect, resetting the backoff counter. */
  manualReconnect() {
    if (this.closedByUs) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
    this._connect();
  }

  _wireXtermEvents() {
    const dataDisposable = this.xterm.onData((data) => {
      if (this.inReplay) return;
      this.sendInput(data);
    });
    const resizeDisposable = this.xterm.onResize(({ cols, rows }) => {
      this._sendResize(cols, rows);
    });
    this.disposables.push(
      () => dataDisposable.dispose(),
      () => resizeDisposable.dispose(),
    );
  }

  _wireDomLifecycle() {
    const host = this.host;
    let resizeTimer = null;
    let latestResizeEntry = null;
    const RESIZE_DEBOUNCE_MS = 100;
    const ro = new ResizeObserver((entries) => {
      // Sprint 29: 100ms debounce instead of rAF-per-frame. The sidebar
      // CSS transition (250ms) previously triggered resize() on every
      // rAF tick (~15 calls), causing visible terminal tearing. With
      // 100ms debounce we get 2-3 resizes per transition — enough to
      // track the animation smoothly without flooding xterm.
      latestResizeEntry = entries[0];
      // Skip entirely during sidebar drag — resize fires once on release.
      if (document.body.classList.contains('is-resizing-sidebar')) return;
      if (resizeTimer) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (this.closedByUs) return;
        const entry = latestResizeEntry;
        latestResizeEntry = null;
        const box = entry?.contentRect;
        if (box) {
          this.layout(box.width, box.height);
        } else {
          this.layout();
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(host);
    this.disposables.push(() => ro.disconnect());

    const onHostClick = () => this.xterm.focus();
    if (this.xterm.isMobile) {
      host.addEventListener('click', onHostClick);
      this.disposables.push(() => host.removeEventListener('click', onHostClick));
    }

    this._wireTabVisibilityRefresh(host);
    this._wireDocumentVisibilityRefresh();
    this._wirePasteHandlers(host);
    this._wireModifiedEnterHandler(host);
    this._wireCompositionHandlers();
  }

  _wireTabVisibilityRefresh(host) {
    const panel = host.closest('.tab-panel');
    if (!panel) return;
    const panelMo = new MutationObserver(() => {
      this.setVisible(this._isHostVisible());
    });
    panelMo.observe(panel, { attributes: true, attributeFilter: ['data-active'] });
    this.disposables.push(() => panelMo.disconnect());
  }

  _wireDocumentVisibilityRefresh() {
    const onVisibilityChange = () => {
      this.setVisible(!document.hidden && this._isHostVisible());
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onVisibilityChange);
    this.disposables.push(
      () => document.removeEventListener('visibilitychange', onVisibilityChange),
      () => window.removeEventListener('focus', onVisibilityChange),
    );
  }

  _wirePasteHandlers(host) {
    const isOurs = () => {
      const ae = document.activeElement;
      return ae && host.contains(ae);
    };
    const doPaste = (text) => {
      if (!text) return;
      const normalized = text.replace(/\r?\n/g, '\r');
      this.sendInput(`\x1b[200~${normalized}\x1b[201~`);
    };
    const onPaste = async (ev) => {
      if (!isOurs()) return;
      let text = '';
      if (ev.clipboardData) text = ev.clipboardData.getData('text');
      if (!text && navigator.clipboard) {
        try { text = await navigator.clipboard.readText(); } catch {}
      }
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      doPaste(text);
    };
    const onKey = (ev) => {
      const meta = ev.ctrlKey || ev.metaKey;
      if (!meta || ev.key.toLowerCase() !== 'v') return;
      if (ev.shiftKey || ev.altKey) return;
      if (!isOurs()) return;
      if (!navigator.clipboard?.readText) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      navigator.clipboard.readText().then((text) => {
        if (text) doPaste(text);
      }).catch(() => {});
    };
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKey, true);
    this.disposables.push(
      () => document.removeEventListener('paste', onPaste, true),
      () => document.removeEventListener('keydown', onKey, true),
    );
  }

  _wireModifiedEnterHandler(host) {
    const isOurs = () => {
      const ae = document.activeElement;
      return ae && host.contains(ae);
    };
    const onShiftEnter = (ev) => {
      if (ev.key !== 'Enter') return;
      if (!(ev.shiftKey || ev.ctrlKey)) return;
      if (ev.metaKey || ev.altKey) return;
      if (!isOurs()) return;
      const data = this.cliType === 'claude' ? '\n' : '\x1b\r';
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      this.sendInput(data);
    };
    document.addEventListener('keydown', onShiftEnter, true);
    this.disposables.push(() => document.removeEventListener('keydown', onShiftEnter, true));
  }

  _wireCompositionHandlers() {
    const helper = this.xterm.helperTextarea;
    this.helperTextarea = helper;
    if (!helper) return;
    const onCompStart = () => this.xterm.setCursorVisible(false);
    const onCompEnd = () => this.xterm.setCursorVisible(true);
    helper.addEventListener('compositionstart', onCompStart);
    helper.addEventListener('compositionend', onCompEnd);
    this.disposables.push(() => {
      helper.removeEventListener('compositionstart', onCompStart);
      helper.removeEventListener('compositionend', onCompEnd);
    });
  }

  _registerColorOscHandlers() {
    const answerColorOsc = (code, getHex) => (data) => {
      if (data !== '?') return false;
      if (this.inReplay) return true;
      const hex = getHex();
      const ch = (i) => parseInt(hex.slice(i, i + 2), 16);
      const w = (v) => (v * 257).toString(16).padStart(4, '0');
      const reply = `\x1b]${code};rgb:${w(ch(1))}/${w(ch(3))}/${w(ch(5))}\x07`;
      this.sendInput(reply);
      return true;
    };
    try {
      this.xterm.parser.registerOscHandler(11, answerColorOsc(11, () => this.xterm.theme.background));
      this.xterm.parser.registerOscHandler(10, answerColorOsc(10, () => this.xterm.theme.foreground));
    } catch {}
  }

  _sendFrame(frame) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  _sendInput(data) {
    if (!data) return;
    if (!this.remoteAccess) {
      this._sendFrame({ type: 'input', data });
      return;
    }
    this.pendingInput += data;
    if (this.inputFlushTimer !== null) return;
    this.inputFlushTimer = setTimeout(() => {
      this.inputFlushTimer = null;
      this._flushInput();
    }, REMOTE_INPUT_FLUSH_MS);
  }

  _flushInput() {
    if (this.inputFlushTimer !== null) {
      clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
    }
    const data = this.pendingInput;
    this.pendingInput = '';
    if (data) this._sendFrame({ type: 'input', data });
  }

  _scheduleThemeRefreshForCli() {
    if (this.cliType !== 'codex') return;
    if (!this.isVisible) {
      this.pendingThemeRefresh = true;
      return;
    }
    if (this.themeRefreshTimer) clearTimeout(this.themeRefreshTimer);
    // Codex caches terminal default colours for its composer. A focus-in
    // event makes it re-query OSC 10/11, which our handlers answer from the
    // just-applied xterm theme.
    this.themeRefreshTimer = setTimeout(() => {
      this.themeRefreshTimer = null;
      if (this.closedByUs || this.cliType !== 'codex' || !this.isVisible) return;
      this._sendFrame({ type: 'input', data: '\x1b[I' });
    }, 40);
  }

  _sendResize(cols, rows, force = false) {
    if (!(cols > 0 && rows > 0)) return;
    if (!force
        && this.lastSentDimensions
        && this.lastSentDimensions.cols === cols
        && this.lastSentDimensions.rows === rows) {
      return;
    }
    this.lastSentDimensions = { cols, rows };
    this._sendFrame({ type: 'resize', cols, rows });
  }

  _beginReplay() {
    this.replayDepth++;
    this.inReplay = true;
  }

  _endReplay() {
    this.replayDepth = Math.max(0, this.replayDepth - 1);
    this.inReplay = this.replayDepth > 0;
  }

  _applyResize(cols, rows) {
    if (this.closedByUs) return;
    if (!(cols > 0 && rows > 0)) return;
    this.xterm.resize(cols, rows);
    this._sendResize(this.xterm.cols, this.xterm.rows);
  }

  _resolveLayoutDimensions(width, height) {
    if (width > 0 && height > 0) {
      return { width, height };
    }
    if (!this.host) return null;
    const rect = this.host.getBoundingClientRect();
    const resolvedWidth = rect.width || this.host.clientWidth;
    const resolvedHeight = rect.height || this.host.clientHeight;
    if (!(resolvedWidth > 0 && resolvedHeight > 0)) return null;
    return { width: resolvedWidth, height: resolvedHeight };
  }

  _cancelScheduledLayout() {
    if (this.pendingLayoutFrame !== null) {
      cancelAnimationFrame(this.pendingLayoutFrame);
      this.pendingLayoutFrame = null;
    }
  }

  _isHostVisible() {
    if (!this.host || !this.host.isConnected || document.hidden) return false;
    const panel = this.host.closest('.tab-panel');
    if (panel && !panel.hasAttribute('data-active')) return false;
    const style = window.getComputedStyle(this.host);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  _wsUrl() {
    const tok = getToken();
    const dev = getDeviceId();
    const params = new URLSearchParams();
    if (tok) params.set('token', tok);
    if (dev) params.set('device', dev);
    const qs = params.toString();
    return `${wsBase()}/ws/terminal/${encodeURIComponent(this.terminalId)}${qs ? `?${qs}` : ''}`;
  }
}
