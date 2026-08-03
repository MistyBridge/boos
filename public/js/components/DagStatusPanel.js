// Sprint 37: DagStatusPanel — DAG execution status dashboard.
// Summary counts + expandable DAG list with cascade task hierarchy.
// Uses fetchDags / fetchDagStatus API. Auto-poll 15s.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { dagList } from '../state.js';
import { fetchDags, fetchDagStatus } from '../api.js';
import { setToast } from '../toast.js';
import { Card } from './Card.js';

// ── Status colors (matching boos tokens) ──────────────────────────

const STATUS = {
  pending:   { color: 'var(--ink-muted)', bg: '#f0f0f0', label: '待处理' },
  active:    { color: '#4a73a5',          bg: '#dce8f5', label: '进行中' },
  completed: { color: '#4a8a4a',          bg: '#d4e8d4', label: '已完成' },
  blocked:   { color: '#b73f3f',          bg: '#f5dcdc', label: '阻塞' },
  submitted: { color: '#cc9a06',          bg: '#fff3cd', label: '已提交' },
  rejected:  { color: '#b73f3f',          bg: '#f8d7da', label: '已拒绝' },
};

function statusDot(status) {
  const s = STATUS[status] || STATUS.pending;
  return html`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};flex-shrink:0;" />`;
}

function statusBadge(status) {
  const s = STATUS[status] || STATUS.pending;
  return html`<span style="font-size:10px;padding:1px 8px;border-radius:999px;background:${s.bg};color:${s.color};font-weight:500;flex-shrink:0;">${s.label}</span>`;
}

// ── Cascade indentation helper ────────────────────────────────────

function buildLevels(tasks, deps) {
  // Assign level via BFS from root nodes (no incoming deps)
  const taskIds = new Set(tasks.map((t) => t.task_id || t.id));
  const inDegree = new Map();
  const adj = new Map();
  for (const tid of taskIds) { inDegree.set(tid, 0); adj.set(tid, []); }
  for (const d of deps) {
    const from = d.from || d.task_id;
    const to = d.to || d.depends_on;
    if (taskIds.has(from) && taskIds.has(to)) {
      adj.get(from).push(to);
      inDegree.set(to, (inDegree.get(to) || 0) + 1);
    }
  }
  const level = new Map();
  const queue = [];
  for (const [tid, deg] of inDegree) {
    if (deg === 0) { queue.push(tid); level.set(tid, 0); }
  }
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of (adj.get(u) || [])) {
      level.set(v, Math.max(level.get(v) || 0, (level.get(u) || 0) + 1));
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) queue.push(v);
    }
  }
  return level;
}

// ── Progress calc ─────────────────────────────────────────────────

function dagProgress(tasks) {
  if (!tasks || tasks.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = tasks.filter((t) => t.status === 'completed').length;
  return { done, total: tasks.length, pct: Math.round((done / tasks.length) * 100) };
}

// ── DAG row ───────────────────────────────────────────────────────

function DagRow({ dag, onSelect }) {
  const tasks = Array.isArray(dag.tasks) ? dag.tasks : [];
  const deps = Array.isArray(dag.dependencies) ? dag.dependencies : [];
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  const progress = dagProgress(tasks);
  const dagStatus = dag.status || 'pending';

  async function onToggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (detail !== null) return;
    setLoading(true);
    try {
      const r = await fetchDagStatus(dag.dag_id || dag.id);
      setDetail(r);
    } catch { /* keep collapsed summary */ }
    setLoading(false);
  }

  const displayTasks = (detail && detail.tasks) ? detail.tasks : tasks;
  const displayDeps = (detail && detail.dependencies) ? detail.dependencies : deps;
  const levels = buildLevels(displayTasks, displayDeps);
  const detailProgress = dagProgress(displayTasks);

  return html`
    <div class="decision-card${expanded ? ' is-expanded' : ''}" style="margin-bottom:var(--s-1);">
      <!-- summary header -->
      <div class="decision-card-head" onClick=${onToggle} style="flex-wrap:wrap;">
        <div class="decision-card-info" style="flex:1;min-width:0;">
          <div class="decision-card-title-row">
            <span class="decision-card-title" style="font-size:13px;">${dag.title || dag.name || dag.dag_id || '未命名 DAG'}</span>
            ${statusBadge(dagStatus)}
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            <div style="flex:0 0 100px;height:4px;background:var(--border);border-radius:999px;overflow:hidden;">
              <div style="width:${progress.pct}%;height:100%;background:${progress.pct >= 100 ? 'var(--green)' : '#4a73a5'};border-radius:999px;transition:width .3s ease;" />
            </div>
            <span style="font-size:11px;color:var(--ink-muted);font-variant-numeric:tabular-nums;">${progress.done}/${progress.total} · ${progress.pct}%</span>
            <span style="font-size:11px;color:var(--ink-muted);">${displayTasks.length} 任务</span>
          </div>
        </div>
        <div class="decision-card-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               style=${{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s ease' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <!-- expanded task list with cascade indent -->
      ${expanded ? html`
        <div class="decision-card-body">
          ${loading ? html`<p class="decision-loading">加载中…</p>` : null}
          ${!loading && displayTasks.length === 0 ? html`
            <p style="font-size:12px;color:var(--ink-muted);text-align:center;padding:var(--s-2);">暂无任务节点</p>
          ` : null}
          ${!loading ? html`
            <div style="display:flex;flex-direction:column;">
              ${displayTasks.map((t) => {
                const tid = t.task_id || t.id;
                const lvl = levels.get(tid) || 0;
                const indent = lvl * 20;
                return html`
                  <div key=${tid}
                       style="display:flex;align-items:center;gap:8px;padding:4px var(--s-2);font-size:12px;margin-left:${indent}px;border-left:${lvl > 0 ? '1px solid var(--border)' : 'none'};margin-left:${indent}px;">
                    ${statusDot(t.status)}
                    <span style="flex:1;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.title || tid}</span>
                    ${statusBadge(t.status)}
                  </div>`;
              })}
            </div>
          ` : null}
        </div>
      ` : null}
    </div>`;
}

// ── Panel ─────────────────────────────────────────────────────────

export function DagStatusPanel({ workspace = 'boos' }) {
  const [loading, setLoading] = useState(false);

  const list = Array.isArray(dagList.value) ? dagList.value : [];

  const load = async () => {
    setLoading(true);
    try { await fetchDags(workspace); } catch { /* keep stale */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [workspace]);

  // counts
  const counts = { active: 0, completed: 0, blocked: 0 };
  for (const d of list) {
    const s = d.status || 'pending';
    if (counts[s] !== undefined) counts[s]++;
  }

  const STAT_CARDS = [
    { key: 'active', label: '活跃', color: '#4a73a5' },
    { key: 'completed', label: '已完成', color: '#4a8a4a' },
    { key: 'blocked', label: '阻塞', color: '#b73f3f' },
  ];

  return html`
    <div style="display:flex;flex-direction:column;gap:var(--s-3);">
      <!-- summary bar -->
      <div style="display:flex;gap:var(--s-2);">
        <div style="flex:1;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-muted);padding:var(--s-2);background:var(--bg);border-radius:6px;border:1px solid var(--border);">
          <span style="font-weight:600;color:var(--ink);">${list.length}</span> 总计
        </div>
        ${STAT_CARDS.map((c) => html`
          <div key=${c.key} style="flex:1;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-muted);padding:var(--s-2);background:var(--bg);border-radius:6px;border:1px solid var(--border);">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.color};flex-shrink:0;" />
            <span style="font-weight:600;color:var(--ink);">${counts[c.key] || 0}</span> ${c.label}
          </div>
        `)}
      </div>

      <!-- DAG list -->
      ${loading && list.length === 0 ? html`
        <p style="font-size:12px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">加载中…</p>
      ` : null}

      ${!loading && list.length === 0 ? html`
        <div style="text-align:center;padding:var(--s-4);color:var(--ink-muted);font-size:13px;">
          <p>暂无活跃 DAG</p>
          <p style="font-size:11px;">等待 PM 创建 DAG 工作流。</p>
        </div>
      ` : null}

      ${list.length > 0 ? html`
        <div class="decisions-list">
          ${list.map((dag) => html`
            <${DagRow} key=${dag.dag_id || dag.id} dag=${dag} />
          `)}
        </div>
      ` : null}
    </div>`;
}
