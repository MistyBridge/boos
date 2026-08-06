// Sprint 41: UsagePage — token usage + cache hit rate telemetry.
// Summary cards (workspace-level) + sessions table with expandable sparklines.
// API: GET /api/usage via fetchUsage(). Live-refreshes every 10s.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { fetchUsage, fetchUsageTrend } from '../api.js';
import { setToast } from '../toast.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';

// ── Formatting helpers ─────────────────────────────────────────────

function fmt(num) {
  if (num == null) return '0';
  return Math.round(num).toLocaleString();
}

function hitRateColor(rate) {
  if (rate == null) return 'var(--ink-muted)';
  if (rate >= 80) return 'var(--green)';
  if (rate >= 50) return '#cc9a06';
  return 'var(--red)';
}

function statusLabel(s) {
  if (s === 'running') return '运行中';
  if (s === 'idle') return '空闲';
  if (s === 'exited') return '已退出';
  if (s === 'deleted') return '已删除';
  return s || '-';
}

// ── Inline SVG sparkline (simple bar chart) ────────────────────────

const SPARK_W = 300, SPARK_H = 36;

function Sparkline({ series }) {
  const [tip, setTip] = useState(null); // { i, x, y, data }

  if (!series || series.length === 0) {
    return html`<span class="mono" style="font-size:11px;color:var(--ink-muted);">无数据</span>`;
  }
  const pts = series.slice(-60);
  const maxVal = Math.max(...pts.map((p) => Math.max(p.input || 0, p.output || 0)), 1);
  const barW = Math.max(1, (SPARK_W / pts.length) - 1);

  const timeStr = (t) => {
    if (!t) return '';
    try { return new Date(t).toLocaleTimeString(); } catch { return t.slice(0, 19); }
  };

  return html`
    <div style="position:relative;display:inline-block;">
      <svg width=${SPARK_W} height=${SPARK_H} style="display:block;background:var(--bg);border-radius:4px;"
           onMouseLeave=${() => setTip(null)}>
        ${pts.map((p, i) => {
          const inH = Math.max(1, ((p.input || 0) / maxVal) * SPARK_H);
          const outH = Math.max(1, ((p.output || 0) / maxVal) * SPARK_H);
          const x = i * (barW + 1);
          return html`
            <g key=${i}>
              <rect x=${x} y=${SPARK_H - inH} width=${barW} height=${inH}
                    fill="#4a73a5" opacity=${tip && tip.i === i ? '0.9' : '0.6'} rx="0.5" />
              <rect x=${x} y=${SPARK_H - outH} width=${barW} height=${outH}
                    fill="#b3614a" opacity=${tip && tip.i === i ? '0.8' : '0.5'} rx="0.5" />
              <!-- invisible hit zone -->
              <rect x=${x} y="0" width=${Math.max(barW, 4)} height=${SPARK_H}
                    fill="transparent"
                    onMouseEnter=${(e) => setTip({ i, x: e.offsetX, y: e.offsetY, data: p })}
                    onMouseMove=${(e) => setTip({ i, x: e.offsetX, y: e.offsetY, data: p })} />
            </g>`;
        })}
      </svg>

      <!-- tooltip -->
      ${tip ? html`
        <div style=${{
          position: 'absolute',
          left: `${Math.min(tip.x + 12, SPARK_W - 180)}px`,
          top: `${Math.max(tip.y - 80, 0)}px`,
          background: 'var(--ink)',
          color: 'var(--bg-elev)',
          fontSize: '11px',
          padding: '6px 10px',
          borderRadius: '6px',
          lineHeight: '1.5',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: '100',
          fontVariantNumeric: 'tabular-nums',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <div style="font-weight:600;margin-bottom:2px;">${timeStr(tip.data.t)}</div>
          <div>输入(未命中): <span style="color:#8db5e0;">${fmt((tip.data.input || 0) + (tip.data.cacheCreation || 0))}</span></div>
          <div>输入(缓存命中): <span style="color:#8db5e0;">${fmt(tip.data.cacheRead)}</span></div>
          <div>输出: <span style="color:#e8b4a8;">${fmt(tip.data.output)}</span></div>
        </div>
      ` : null}
    </div>`;
}

// ── Summary card (inline style only for dynamic color + text-align) ─

function SummaryCard({ label, value, sub, color }) {
  return html`
    <article class="card" style="flex:1;min-width:130px;text-align:center;">
      <div style=${`font-size:20px;font-weight:700;color:${color || 'var(--ink)'};font-variant-numeric:tabular-nums;line-height:1.2;`}>
        ${value}
      </div>
      <p class="card-meta" style="margin-top:2px;">${label}</p>
      ${sub ? html`<p style="font-size:10px;color:var(--ink-muted);margin:0;">${sub}</p>` : null}
    </article>`;
}

// ── Sprint 42: time-bucketed usage trend ─────────────────────────────
// Granularity switch (month/week/day/hour/minute) + bar chart + tooltip.

const GRANULARITIES = [
  ['month', '月'], ['week', '周'], ['day', '日'], ['hour', '小时'], ['minute', '分钟'],
];

const TREND_W = 860, TREND_H = 140;

function trendTimeLabel(granularity, t) {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  switch (granularity) {
    case 'minute': return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    case 'hour': return `${pad(d.getHours())}:00`;
    case 'day': return `${d.getMonth() + 1}/${d.getDate()}`;
    case 'week': return `${d.getMonth() + 1}/${d.getDate()}周`;
    case 'month': return `${d.getFullYear()}/${d.getMonth() + 1}`;
    default: return d.toLocaleString();
  }
}

function TimeBars({ buckets, granularity }) {
  const [tip, setTip] = useState(null);

  if (!buckets || buckets.length === 0) {
    return html`<span class="mono" style="font-size:12px;color:var(--ink-muted);">该时间段暂无数据</span>`;
  }

  const maxVal = Math.max(...buckets.map((b) =>
    Math.max((b.input || 0) + (b.cacheCreation || 0), b.output || 0)), 1);
  const barW = Math.max(2, (TREND_W / buckets.length) - 2);

  // 柱高下限 — 全 0 桶显示 2px 底痕
  const h = (v) => Math.max(v > 0 ? 3 : 2, (v / maxVal) * TREND_H);

  return html`
    <div style="position:relative;">
      <svg width=${TREND_W} height=${TREND_H} style="display:block;background:var(--bg);border-radius:6px;border:1px solid var(--border);"
           onMouseLeave=${() => setTip(null)}>
        ${buckets.map((b, i) => {
          const missIn = (b.input || 0) + (b.cacheCreation || 0);
          const x = i * (barW + 2);
          return html`
            <g key=${i}>
              <rect x=${x} y=${TREND_H - h(missIn)} width=${barW} height=${h(missIn)}
                    fill="#4a73a5" opacity=${tip && tip.i === i ? '0.9' : '0.55'} rx="1" />
              <rect x=${x} y=${TREND_H - h(b.output || 0)} width=${barW} height=${h(b.output || 0)}
                    fill="#b3614a" opacity=${tip && tip.i === i ? '0.85' : '0.5'} rx="1" />
              <rect x=${x} y="0" width=${Math.max(barW, 6)} height=${TREND_H} fill="transparent"
                    onMouseEnter=${(e) => setTip({ i, x: e.offsetX, y: e.offsetY, data: b })}
                    onMouseMove=${(e) => setTip({ i, x: e.offsetX, y: e.offsetY, data: b })} />
            </g>`;
        })}
      </svg>

      ${tip ? html`
        <div style=${{
          position: 'absolute',
          left: `${Math.min(tip.x + 12, TREND_W - 200)}px`,
          top: `${Math.max(tip.y - 92, 0)}px`,
          background: 'var(--ink)', color: 'var(--bg-elev)',
          fontSize: '11px', padding: '6px 10px', borderRadius: '6px',
          lineHeight: '1.5', pointerEvents: 'none', whiteSpace: 'nowrap',
          zIndex: '100', fontVariantNumeric: 'tabular-nums',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <div style="font-weight:600;margin-bottom:2px;">${trendTimeLabel(granularity, tip.data.t)}</div>
          <div>输入(未命中): <span style="color:#8db5e0;">${fmt((tip.data.input || 0) + (tip.data.cacheCreation || 0))}</span></div>
          <div>输入(缓存命中): <span style="color:#8db5e0;">${fmt(tip.data.cacheRead)}</span></div>
          <div>输出: <span style="color:#e8b4a8;">${fmt(tip.data.output)}</span></div>
        </div>
      ` : null}
    </div>`;
}

function TrendSection() {
  const [gran, setGran] = useState('hour');
  const [trend, setTrend] = useState(null);
  const [loadingTrend, setLoadingTrend] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingTrend(true);
    fetchUsageTrend(gran)
      .then((r) => { if (!cancelled) setTrend(r); })
      .catch((e) => { if (!cancelled) setToast(e.message || '加载趋势失败', 'error'); })
      .finally(() => { if (!cancelled) setLoadingTrend(false); });
    return () => { cancelled = true; };
  }, [gran]);

  return html`
    <div class="card" style="margin-bottom:var(--s-3);padding:var(--s-3) var(--s-4);">
      <div class="row" style="align-items:center;justify-content:space-between;margin-bottom:var(--s-2);">
        <div style="font-size:13px;font-weight:600;">时间段用量</div>
        <div class="row" style="gap:4px;">
          ${GRANULARITIES.map(([g, label]) => html`
            <button class="action subtle small" style=${gran === g
              ? 'background:var(--ink);color:var(--bg-elev);border-color:var(--ink);'
              : ''}
              onClick=${() => setGran(g)}>${label}</button>
          `)}
        </div>
      </div>
      ${loadingTrend ? html`<p style="font-size:12px;color:var(--ink-muted);">加载中…</p>` : null}
      ${!loadingTrend ? html`<${TimeBars} buckets=${trend?.buckets || []} granularity=${gran} />` : null}
    </div>`;
}

// ── Page ──────────────────────────────────────────────────────────

export function UsagePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const load = async (opts = {}) => {
    const silent = opts.silent;
    if (!silent) setLoading(true);
    try {
      const r = await fetchUsage();
      setData(r);
    } catch (e) {
      if (!silent) setToast(e.message || '加载用量数据失败', 'error');
    }
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load({ silent: true }), 10_000);
    return () => clearInterval(t);
  }, []);

  const ws = data?.workspace || {};
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const hitRate = ws.hitRate != null ? ws.hitRate.toFixed(1) + '%' : '—';
  const recentHr = ws.recent?.hitRate != null ? ws.recent.hitRate.toFixed(1) + '%' : null;

  return html`
    <${ErrorBoundary} name="UsagePage">
      <${PageTitleBar} title="用量监控">
        <button class="action subtle small" onClick=${load} disabled=${loading}>
          ${loading ? '刷新中…' : '刷新'}
        </button>
      </${PageTitleBar}>

      <div class="settings-scroll">
        <!-- summary cards — reused .card for surface, flex for layout -->
        <div class="row" style="gap:var(--s-2);margin-bottom:var(--s-3);flex-wrap:wrap;">
          <${SummaryCard} label="输入(未命中)" value=${fmt((ws.input || 0) + (ws.cacheCreation || 0))} color="var(--ink)" />
          <${SummaryCard} label="输入(缓存命中)" value=${fmt(ws.cacheRead)} color="var(--green)" />
          <${SummaryCard} label="输出" value=${fmt(ws.output)} color="var(--ink)" />
          <${SummaryCard} label="缓存命中率" value=${hitRate}
            color=${hitRateColor(ws.hitRate)}
            sub=${recentHr ? `最近100条: ${recentHr}` : null} />
          <${SummaryCard} label="会话数" value=${sessions.length} color="var(--ink-mid)" />
        </div>

        <${TrendSection} />

        ${loading ? html`
          <p style="font-size:13px;color:var(--ink-muted);text-align:center;padding:var(--s-4);">加载中…</p>
        ` : null}

        ${!loading && sessions.length === 0 ? html`
          <div class="decisions-empty">
            <p class="decisions-empty-title">暂无活跃会话</p>
            <p class="decisions-empty-hint">启动 BOOS 会话后，用量数据将在此显示。</p>
          </div>
        ` : null}

        ${!loading && sessions.length > 0 ? html`
          <div class="table-scroll">
            <table class="data">
              <thead>
                <tr>
                  <th>会话</th>
                  <th class="path-cell">目录</th>
                  <th>状态</th>
                  <th class="num">输入(未命中)</th>
                  <th class="num">输入(缓存命中)</th>
                  <th class="num">输出</th>
                  <th class="num">命中率</th>
                </tr>
              </thead>
              <tbody class="no-anim">
                ${sessions.map((s) => {
                  const isExpanded = expandedId === s.id;
                  const hr = s.hitRate;
                  const hrColor = hitRateColor(hr);
                  const u = s.usage || {};
                  const missTotal = (u.input || 0) + (u.cacheCreation || 0);

                  return html`
                    <tr key=${s.id} style="cursor:pointer;"
                        onClick=${() => setExpandedId(isExpanded ? null : s.id)}>
                      <td>
                        <span class="row" style="gap:6px;align-items:center;">
                          <span style="font-weight:500;">${s.cliId || '-'}</span>
                        </span>
                      </td>
                      <td class="path-cell" title=${s.title || s.cwd || s.projectSlug || ''}>
                        ${s.title || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || (s.orphan ? (s.projectSlug || '').split(/[\\/-]/).filter(Boolean).pop() + '·' + s.id.slice(-8) : '-')}
                      </td>
                      <td>
                        <span class="status-mark ${s.status === 'running' ? 'busy' : ''}"
                              style="vertical-align:middle;margin-right:4px;" />
                        ${statusLabel(s.status)}
                      </td>
                      <td class="num">${fmt(missTotal)}</td>
                      <td class="num">${fmt(u.cacheRead)}</td>
                      <td class="num">${fmt(u.output)}</td>
                      <td class="num">
                        <span style=${`font-weight:600;color:${hrColor};`}>
                          ${hr != null ? hr.toFixed(1) + '%' : '—'}
                        </span>
                      </td>
                    </tr>
                    ${isExpanded ? html`
                      <tr key=${s.id + '-exp'}>
                        <td colspan="7" style="padding:var(--s-2) var(--s-6);">
                          <div style="font-size:11px;color:var(--ink-muted);margin-bottom:4px;">
                            最近 ${(s.series || []).slice(-60).length} 条消息的 Token 使用趋势
                            <span style="margin-left:8px;display:inline-flex;align-items:center;gap:4px;">
                              <span style="display:inline-block;width:8px;height:8px;background:#4a73a5;opacity:0.6;border-radius:2px;" />输入
                              <span style="display:inline-block;width:8px;height:8px;background:#b3614a;opacity:0.5;border-radius:2px;" />输出
                            </span>
                          </div>
                          <${Sparkline} series=${s.series || []} />
                        </td>
                      </tr>
                    ` : null}
                  `;
                })}
              </tbody>
            </table>
          </div>
        ` : null}
      </div>
    </${ErrorBoundary}>`;
}
