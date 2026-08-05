// Sprint 37 Phase 4: FeedbackTimeline — vertical chat-like timeline for goal feedback events.
// Pulls feedback from goal_status API. Pure display component.

import { html } from '../html.js';

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}

export function FeedbackTimeline({ feedback }) {
  const items = Array.isArray(feedback) ? feedback : [];

  if (items.length === 0) {
    return html`<p style="font-size:13px;color:var(--ink-muted);text-align:center;padding:var(--s-4);">暂无反馈记录。</p>`;
  }

  return html`
    <div style="display:flex;flex-direction:column;gap:var(--s-2);position:relative;">
      <!-- Vertical line -->
      <div style="position:absolute;left:12px;top:0;bottom:0;width:1px;background:var(--border);" />

      ${items.map((fb, i) => html`
        <div key=${i} style="position:relative;padding-left:32px;">
          <!-- Dot on the line -->
          <div style="position:absolute;left:8px;top:6px;width:9px;height:9px;border-radius:50%;
                      background:${fb.type === 'error' ? 'var(--red)' : fb.type === 'warning' ? '#cc9a06' : 'var(--blue)'};
                      border:2px solid var(--bg-elev);" />

          <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:var(--s-2);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
              <span style="font-size:12px;font-weight:600;color:var(--ink);">${fb.from || fb.sender || '系统'}</span>
              <span style="font-size:10px;color:var(--ink-muted);">${timeAgo(fb.at || fb.created_at)}</span>
            </div>
            <p style="font-size:13px;color:var(--ink-mid);margin:0;line-height:1.5;white-space:pre-wrap;">
              ${fb.message || fb.content || fb.body || ''}
            </p>
            ${fb.target_task_id ? html`
              <div class="mono" style="font-size:10px;color:var(--ink-muted);margin-top:4px;">
                task: ${fb.target_task_id.slice(0, 20)}
              </div>
            ` : null}
          </div>
        </div>
      `)}
    </div>`;
}
