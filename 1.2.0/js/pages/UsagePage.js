// Sprint 41: UsagePage — token usage + cache hit rate telemetry.
// Summary cards (workspace-level) + sessions table with expandable sparklines.
// API: GET /api/usage via fetchUsage().

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { fetchUsage } from '../api.js';
import { setToast } from '../toast.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { PageTitleBar } from '../components/PageTitleBar.js';

// ── Formatting helpers ─────────────────────────────────────────────

function fmt(num) {
  if (num == null) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(Math.round(num));
}

function hitRateColor(rate) {
  if (rate == null) return 'var(--ink-muted)';
  if (rate >= 80) return '#4a8a4a';
  if (rate >= 50) return '#cc9a06';
  return '#b73f3f';
}

function statusLabel(s) {
  if (s === 'running') return '运行中';
  if (s === 'idle') return '空闲';
  if (s === 'exited') return '已退出';
  return s || '-';
}

// ── Inline SVG sparkline (simple bar chart) ────────────────────────

const SPARK_W = 300, SPARK_H = 36;

function Sparkline({ series }) {
  if (!series || series.length === 0) {
    return html`<span style="font-size:11px;color:var(--ink-muted);">无数据</span>`;
  }
  const pts = series.slice(-60); // last 60 entries
  const maxVal = Math.max(...pts.map((p) => Math.max(p.input || 0, p.output || 0)), 1);
  const barW = Math.max(1, (SPARK_W / pts.length) - 1);

  return html`
    <svg width=${SPARK_W} height=${SPARK_H} style="display:block;background:var(--bg);border-radius:4px;">
      ${pts.map((p, i) => {
        const inH = Math.max(1, ((p.input || 0) / maxVal) * SPARK_H);
        const outH = Math.max(1, ((p.output || 0) / maxVal) * SPARK_H);
        const x = i * (barW + 1);
        return html`
          <g key=${i}>
            <rect x=${x} y=${SPARK_H - inH} width=${barW} height=${inH}
                  fill="#4a73a5" opacity="0.6" rx="0.5" />
            <rect x=${x} y=${SPARK_H - outH} width=${barW} height=${outH}
                  fill="#b3614a" opacity="0.5" rx="0.5" />
          </g>`;
      })}
    </svg>`;
}

// ── Summary card ──────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color }) {
  return html`
    <div style="flex:1;min-width:120px;padding:var(--s-3);background:var(--bg-elev);border-radius:8px;border:1px solid var(--border);text-align:center;">
      <div style="font-size:24px;font-weight:700;color:${color || 'var(--ink)'};font-variant-numeric:tabular-nums;line-height:1.2;">
        ${value}
      </div>
      <div style="font-size:11px;color:var(--ink-muted);margin-top:2px;">${label}</div>
      ${sub ? html`<div style="font-size:10px;color:var(--ink-muted);">${sub}</div>` : null}
    </div>`;
}

// ── Page ──────────────────────────────────────────────────────────

export function UsagePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchUsage();
      setData(r);
    } catch (e) {
      setToast(e.message || '加载用量数据失败', 'error');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const ws = data?.workspace || {};
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const hitRate = ws.hitRate != null ? ws.hitRate.toFixed(1) + '%' : '—';

  return html`
    <${ErrorBoundary} name="UsagePage">
      <${PageTitleBar} title="用量监控">
        <button class="action subtle small" onClick=${load} style="font-size:12px;padding:2px 12px;" disabled=${loading}>
          ${loading ? '刷新中…' : '刷新'}
        </button>
      </${PageTitleBar}>

      <div class="decisions-page">
        <!-- summary cards -->
        <div style="display:flex;gap:var(--s-2);margin-bottom:var(--s-3);flex-wrap:wrap;">
          <${SummaryCard} label="总输入 Token" value=${fmt(ws.input)} color="var(--ink)" />
          <${SummaryCard} label="总输出 Token" value=${fmt(ws.output)} color="var(--ink)" />
          <${SummaryCard} label="缓存读取" value=${fmt(ws.cacheRead)} color="#4a73a5" />
          <${SummaryCard} label="缓存写入" value=${fmt(ws.cacheCreation)} sub="new entries" color="#4a73a5" />
          <${SummaryCard} label="缓存命中率" value=${hitRate}
            color=${hitRateColor(ws.hitRate)}
            sub=${`${sessions.length} 个会话`} />
        </div>

        <!-- sessions table -->
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
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;">
              <thead>
                <tr style="border-bottom:2px solid var(--border);">
                  <th style="text-align:left;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">会话</th>
                  <th style="text-align:left;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">目录</th>
                  <th style="text-align:left;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">状态</th>
                  <th style="text-align:right;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">输入</th>
                  <th style="text-align:right;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">缓存读</th>
                  <th style="text-align:right;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">缓存写</th>
                  <th style="text-align:right;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">输出</th>
                  <th style="text-align:right;padding:6px 8px;color:var(--ink-muted);font-weight:500;white-space:nowrap;">命中率</th>
                </tr>
              </thead>
              <tbody>
                ${sessions.map((s) => {
                  const isExpanded = expandedId === s.id;
                  const hr = s.hitRate;
                  const hrColor = hitRateColor(hr);
                  const u = s.usage || {};

                  return html`
                    <tr key=${s.id}
                        style="border-bottom:1px solid var(--border);cursor:pointer;"
                        onClick=${() => setExpandedId(isExpanded ? null : s.id)}
                        onMouseEnter=${(e) => { e.currentTarget.style.background = 'var(--bg)'; }}
                        onMouseLeave=${(e) => { e.currentTarget.style.background = ''; }}>
                      <td style="padding:6px 8px;white-space:nowrap;">
                        <span style="font-weight:500;">${s.cliId || '-'}</span>
                      </td>
                      <td style="padding:6px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-mid);"
                          title=${s.title || s.cwd || ''}>
                        ${s.title || (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '-'}
                      </td>
                      <td style="padding:6px 8px;white-space:nowrap;">
                        <span style="font-size:10px;color:${s.status === 'running' ? '#4a73a5' : 'var(--ink-muted)'};">${statusLabel(s.status)}</span>
                      </td>
                      <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${fmt(u.input)}</td>
                      <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${fmt(u.cacheRead)}</td>
                      <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${fmt(u.cacheCreation)}</td>
                      <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${fmt(u.output)}</td>
                      <td style="padding:6px 8px;text-align:right;white-space:nowrap;font-weight:600;color:${hrColor};">
                        ${hr != null ? hr.toFixed(1) + '%' : '—'}
                      </td>
                    </tr>
                    ${isExpanded ? html`
                      <tr key=${s.id + '-exp'}>
                        <td colspan="8" style="padding:8px;">
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
