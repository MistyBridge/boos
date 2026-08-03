// Sprint 37: CompositeDagGraph — dagre layout + SVG DAG visualisation.
// Supports zoom/pan via mouse wheel + drag. Node colors by task status.
// Renders one or more disconnected DAGs within a single composite view.

import { html } from '../html.js';
import { useRef, useEffect, useState } from 'preact/hooks';

// ── dagre layout (inline small subset — avoids npm dependency for MVP) ──

function simpleLayout(dags) {
  // Collect all tasks from all DAGs with their dependencies.
  // Simple layered layout: topological sort → assign layers → position nodes.
  const allTasks = [];
  const taskMap = new Map();
  const edges = [];

  for (const dag of dags) {
    const tasks = dag.tasks || [];
    for (const t of tasks) {
      const id = t.task_id || t.id;
      taskMap.set(id, { ...t, _id: id, _dagTitle: dag.title || dag.dag_id });
      allTasks.push(taskMap.get(id));
    }
    // Collect edges from dependencies.
    for (const t of tasks) {
      const deps = t.dependencies || t.depends_on || [];
      for (const dep of deps) {
        const depId = typeof dep === 'string' ? dep : (dep.task_id || dep.id);
        if (taskMap.has(depId)) {
          edges.push({ from: depId, to: t.task_id || t.id });
        }
      }
    }
  }

  // Topological sort for layer assignment.
  const inDegree = new Map();
  const adj = new Map();
  for (const t of allTasks) {
    inDegree.set(t._id, 0);
    adj.set(t._id, []);
  }
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
  }

  const queue = [];
  const layer = new Map();
  for (const t of allTasks) {
    if (inDegree.get(t._id) === 0) { queue.push(t._id); layer.set(t._id, 0); }
  }
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of (adj.get(u) || [])) {
      const newLayer = Math.max(layer.get(v) || 0, (layer.get(u) || 0) + 1);
      layer.set(v, newLayer);
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) queue.push(v);
    }
  }

  // Assign positions.
  const LAYER_GAP = 80;
  const NODE_GAP = 100;
  const layers = new Map(); // layer → [nodeIds]
  for (const t of allTasks) {
    const l = layer.get(t._id) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(t._id);
  }

  const positions = new Map();
  for (const [l, ids] of layers) {
    const totalWidth = (ids.length - 1) * NODE_GAP;
    ids.forEach((id, i) => {
      const x = 60 + i * NODE_GAP - totalWidth / 2;
      const y = 40 + l * LAYER_GAP;
      positions.set(id, { x, y });
    });
  }

  return { nodes: allTasks, edges, positions, layers };
}

// ── node colors by status ──
const STATUS_COLORS = {
  proposed:   { fill: '#d4d4d4', stroke: '#999', text: '#555' },
  pending:    { fill: '#fff3cd', stroke: '#cc9a06', text: '#664d03' },
  active:     { fill: '#cfe2ff', stroke: '#4a73a5', text: '#08335a' },
  submitted:  { fill: '#ffe5cc', stroke: '#d97706', text: '#6b3800' },
  approved:   { fill: '#d1e7dd', stroke: '#4a8a4a', text: '#0a3622' },
  rejected:   { fill: '#f8d7da', stroke: '#b73f3f', text: '#58151c' },
};
const DEFAULT_COLOR = { fill: '#f0f0f0', stroke: '#999', text: '#555' };

const NODE_W = 140;
const NODE_H = 48;

function colorForStatus(status) {
  return STATUS_COLORS[status] || DEFAULT_COLOR;
}

// ── component ──

export function CompositeDagGraph({ dags, onNodeClick }) {
  const svgRef = useRef(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [dragState, setDragState] = useState(null); // { startX, startY, origX, origY }

  const list = Array.isArray(dags) ? dags : [];
  const layout = list.length > 0 ? simpleLayout(list) : { nodes: [], edges: [], positions: new Map() };

  const maxY = layout.nodes.length > 0
    ? Math.max(...layout.nodes.map((n) => {
        const p = layout.positions.get(n._id) || { y: 0 };
        return p.y;
      })) + NODE_H + 20
    : 200;

  const maxX = layout.nodes.length > 0
    ? Math.max(...layout.nodes.map((n) => {
        const p = layout.positions.get(n._id) || { x: 0 };
        return p.x;
      })) + NODE_W + 20
    : 400;

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((prev) => ({
      ...prev,
      scale: Math.max(0.2, Math.min(3, prev.scale * delta)),
    }));
  };

  const handleMouseDown = (e) => {
    if (e.target.closest('.dag-node')) return; // don't drag when clicking a node
    setDragState({ startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y });
  };

  const handleMouseMove = (e) => {
    if (!dragState) return;
    setTransform((prev) => ({
      ...prev,
      x: dragState.origX + (e.clientX - dragState.startX),
      y: dragState.origY + (e.clientY - dragState.startY),
    }));
  };

  const handleMouseUp = () => { setDragState(null); };

  const handleNodeClick = (task) => {
    if (onNodeClick) onNodeClick(task);
  };

  if (list.length === 0) {
    return html`<div style="padding:var(--s-4);text-align:center;color:var(--ink-muted);font-size:13px;">
      暂无 DAG 任务。创建目标后，PM 将拆解并生成 DAG。
    </div>`;
  }

  return html`
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg);">
      <svg ref=${svgRef}
           width="100%" height="400"
           style="display:block;cursor:${dragState ? 'grabbing' : 'grab'};"
           onWheel=${handleWheel}
           onMouseDown=${handleMouseDown}
           onMouseMove=${handleMouseMove}
           onMouseUp=${handleMouseUp}
           onMouseLeave=${handleMouseUp}
           viewBox=${`${-transform.x / transform.scale} ${-transform.y / transform.scale} ${(maxX + 100) / transform.scale} ${(maxY + 100) / transform.scale}`}>
        <g transform=${`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          <!-- Edges -->
          ${layout.edges.map((e) => {
            const fromPos = layout.positions.get(e.from);
            const toPos = layout.positions.get(e.to);
            if (!fromPos || !toPos) return null;
            return html`<line key=${`${e.from}->${e.to}`}
              x1=${fromPos.x + NODE_W / 2} y1=${fromPos.y + NODE_H}
              x2=${toPos.x + NODE_W / 2} y2=${toPos.y}
              stroke="var(--border)" stroke-width="1.5"
              marker-end="url(#arrowhead)" />`;
          })}

          <!-- Arrow marker def -->
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="var(--ink-muted)" />
            </marker>
          </defs>

          <!-- Nodes -->
          ${layout.nodes.map((t) => {
            const pos = layout.positions.get(t._id) || { x: 0, y: 0 };
            const c = colorForStatus(t.status);
            return html`
              <g key=${t._id} class="dag-node" transform=${`translate(${pos.x},${pos.y})`}
                 onClick=${() => handleNodeClick(t)} style="cursor:pointer;">
                <rect width=${NODE_W} height=${NODE_H} rx="6"
                      fill=${c.fill} stroke=${c.stroke} stroke-width="1.5" />
                <text x=${NODE_W / 2} y="18" text-anchor="middle"
                      fill=${c.text} font-size="11" font-weight="600"
                      font-family="var(--font-mono),monospace">${(t.title || t.task_id || t._id).slice(0, 18)}</text>
                <text x=${NODE_W / 2} y="36" text-anchor="middle"
                      fill="var(--ink-muted)" font-size="10"
                      font-family="var(--font-mono),monospace">${t.status || 'pending'}</text>
              </g>`;
          })}
        </g>
      </svg>
    </div>`;
}
