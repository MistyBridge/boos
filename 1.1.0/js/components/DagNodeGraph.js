// Sprint 37 Phase 4: DagNodeGraph — simple directed SVG graph for DAG task nodes.
// Topological-sort layer layout. Zoom via wheel, pan via drag. No external deps.
// Node colors: pending=灰, active=蓝, submitted=黄, approved=绿, rejected=红, escalated=橙.

import { html } from '../html.js';
import { useRef, useState } from 'preact/hooks';

// ── layout engine ──

function layoutNodes(tasks, dependencies) {
  // tasks: [{task_id, title, status}], dependencies: [{from, to}]
  const nodes = tasks.map((t) => ({ ...t, _id: t.task_id || t.id }));
  const nodeMap = new Map(nodes.map((n) => [n._id, n]));

  const edges = [];
  for (const dep of dependencies) {
    const fromId = typeof dep === 'string' ? dep : (dep.from || dep.task_id);
    const toId = dep.to || dep.depends_on;
    if (nodeMap.has(fromId) && nodeMap.has(toId)) {
      edges.push({ from: fromId, to: toId });
    }
  }

  // Topological sort → layer assignment
  const inDegree = new Map();
  const adj = new Map();
  for (const n of nodes) { inDegree.set(n._id, 0); adj.set(n._id, []); }
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
  }

  const queue = [];
  const layer = new Map();
  for (const n of nodes) {
    if (inDegree.get(n._id) === 0) { queue.push(n._id); layer.set(n._id, 0); }
  }
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of (adj.get(u) || [])) {
      layer.set(v, Math.max(layer.get(v) || 0, (layer.get(u) || 0) + 1));
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) queue.push(v);
    }
  }

  // Assign positions
  const LAYER_GAP = 90;
  const NODE_GAP = 110;
  const layers = new Map();
  for (const n of nodes) {
    const l = layer.get(n._id) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(n._id);
  }

  const positions = new Map();
  for (const [l, ids] of layers) {
    const totalW = (ids.length - 1) * NODE_GAP;
    ids.forEach((id, i) => {
      positions.set(id, { x: 60 + i * NODE_GAP - totalW / 2, y: 40 + l * LAYER_GAP });
    });
  }

  return { nodes, edges, positions };
}

// ── color map ──

const STATUS_COLORS = {
  pending:    { fill: '#f0f0f0', stroke: '#999', text: '#555' },
  active:     { fill: '#cfe2ff', stroke: '#4a73a5', text: '#08335a' },
  submitted:  { fill: '#fff3cd', stroke: '#cc9a06', text: '#664d03' },
  approved:   { fill: '#d1e7dd', stroke: '#4a8a4a', text: '#0a3622' },
  rejected:   { fill: '#f8d7da', stroke: '#b73f3f', text: '#58151c' },
  escalated:  { fill: '#ffe5cc', stroke: '#d97706', text: '#6b3800' },
};
const DEFAULT_COLOR = { fill: '#f0f0f0', stroke: '#999', text: '#555' };

const NODE_W = 150;
const NODE_H = 52;

function nodeColor(status) { return STATUS_COLORS[status] || DEFAULT_COLOR; }

export function DagNodeGraph({ dag, onNodeClick }) {
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef(null);

  if (!dag) {
    return html`<div style="padding:var(--s-4);text-align:center;color:var(--ink-muted);font-size:13px;">无 DAG 数据</div>`;
  }

  const tasks = Array.isArray(dag.tasks) ? dag.tasks : (Array.isArray(dag) ? dag : []);
  const deps = Array.isArray(dag.dependencies) ? dag.dependencies : [];

  if (tasks.length === 0) {
    return html`<div style="padding:var(--s-4);text-align:center;color:var(--ink-muted);font-size:13px;">DAG 暂无任务节点</div>`;
  }

  const layout = layoutNodes(tasks, deps);

  const maxY = layout.nodes.length > 0
    ? Math.max(...layout.nodes.map((n) => layout.positions.get(n._id)?.y || 0)) + NODE_H + 40
    : 300;
  const maxX = layout.nodes.length > 0
    ? Math.max(...layout.nodes.map((n) => layout.positions.get(n._id)?.x || 0)) + NODE_W + 40
    : 500;

  const handleWheel = (e) => {
    e.preventDefault();
    setTransform((p) => ({
      ...p,
      scale: Math.max(0.2, Math.min(3, p.scale * (e.deltaY > 0 ? 0.9 : 1.1))),
    }));
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.dng-node')) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: transform.x, oy: transform.y };
  };
  const handleMouseMove = (e) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    setTransform((p) => ({ ...p, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const handleMouseUp = () => { dragRef.current = null; };

  const fullW = Math.max(600, maxX + 200);
  const fullH = Math.max(350, maxY + 100);

  return html`
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg);">
      <svg width="100%" height=${Math.min(500, fullH)} style="display:block;background:#fafaf5;"
           onWheel=${handleWheel}
           onMouseDown=${handleMouseDown}
           onMouseMove=${handleMouseMove}
           onMouseUp=${handleMouseUp}
           onMouseLeave=${handleMouseUp}>
        <defs>
          <marker id="dng-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="var(--ink-muted)" />
          </marker>
        </defs>
        <g transform=${`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          ${layout.edges.map((e) => {
            const fp = layout.positions.get(e.from);
            const tp = layout.positions.get(e.to);
            if (!fp || !tp) return null;
            return html`<line key=${`${e.from}->${e.to}`}
              x1=${fp.x + NODE_W / 2} y1=${fp.y + NODE_H}
              x2=${tp.x + NODE_W / 2} y2=${tp.y}
              stroke="var(--border)" stroke-width="1.5" marker-end="url(#dng-arrow)" />`;
          })}
          ${layout.nodes.map((t) => {
            const pos = layout.positions.get(t._id) || { x: 0, y: 0 };
            const c = nodeColor(t.status);
            return html`
              <g key=${t._id} class="dng-node" transform=${`translate(${pos.x},${pos.y})`}
                 onClick=${() => onNodeClick && onNodeClick(t)} style="cursor:pointer;">
                <rect width=${NODE_W} height=${NODE_H} rx="6" fill=${c.fill} stroke=${c.stroke} stroke-width="1.5" />
                <text x=${NODE_W / 2} y="19" text-anchor="middle" fill=${c.text} font-size="11" font-weight="600">${(t.title || t._id).slice(0, 20)}</text>
                <text x=${NODE_W / 2} y="37" text-anchor="middle" fill="var(--ink-muted)" font-size="10">${t.status || 'pending'} · ${(t.executor || '?').slice(0, 12)}</text>
              </g>`;
          })}
        </g>
      </svg>
    </div>`;
}
