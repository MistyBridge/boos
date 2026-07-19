// Free-form canvas for agent node positioning.
// Supports: drag-to-move nodes, Ctrl+Wheel zoom, right-click pan (placeholder),
// double-click to select agent. Positions persist to layout.json.
//
// Coordinate system: nodes are rendered at virtual (x,y), transformed by
// canvas pan offset + scale. Saved positions are always virtual coordinates.

import { html } from '../html.js';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { AgentNode } from './AgentNode.js';

// Minimum px of a node that must remain visible when dragged to canvas edge.
const MIN_VISIBLE_PX = 40;
// Debounce ms before saving layout after position change.
const SAVE_DEBOUNCE_MS = 500;

/**
 * @param {{ agents: Array<{id, title, activity, cliType}>,
 *            positions: Record<string, {x:number, y:number}>,
 *            activeAgentId: string|null,
 *            onSelectAgent: (uid:string) => void,
 *            onSaveLayout: (data: {agentPositions:Record<string,{x,y}>, scale:number, offset:{x,y}}) => void }} props
 */
export function AgentCanvas({ agents, positions, activeAgentId, onSelectAgent, onSaveLayout }) {
  const canvasRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Track which node is being dragged + pointer offset within the node.
  const dragState = useRef(null);
  const saveTimer = useRef(null);

  // ── position helpers ────────────────────────────────────────────

  /** Get saved or default position for an agent. */
  const getPosition = useCallback((agent, index) => {
    if (positions && positions[agent.id]) return positions[agent.id];
    // Auto-layout: grid if no saved position.
    const col = index % 4;
    const row = Math.floor(index / 4);
    return { x: 40 + col * 180, y: 40 + row * 120 };
  }, [positions]);

  /** Debounced save of current layout state. */
  const _scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Build positions from node DOM elements (they have inline styles).
      const pos = {};
      if (canvasRef.current) {
        const nodes = canvasRef.current.querySelectorAll('.agent-node');
        nodes.forEach((el) => {
          const uid = el.dataset.agentId;
          if (uid) pos[uid] = { x: parseInt(el.style.left) || 0, y: parseInt(el.style.top) || 0 };
        });
      }
      onSaveLayout({ agentPositions: pos, scale, offset });
    }, SAVE_DEBOUNCE_MS);
  }, [scale, offset, onSaveLayout]);

  // ── drag handlers ───────────────────────────────────────────────
  // Touch devices: require a 300ms long-press before dragging starts,
  // so a quick tap or scroll gesture doesn't accidentally move nodes.
  const touchTimer = useRef(null);
  const LONG_PRESS_MS = 300;
  const DRAG_HYST = 4; // px movement before drag activates (after long-press)

  const _onDragStart = useCallback((agentId) => (e) => {
    e.preventDefault();
    const node = e.currentTarget;
    const rect = node.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;

    // If this is a touch event (pointerType === 'touch'), delay drag
    // activation by LONG_PRESS_MS so quick taps don't trigger a drag.
    const isTouch = e.pointerType === 'touch';
    if (isTouch) {
      // Don't capture yet — let the timer decide.
      dragState.current = null;
      touchTimer.current = setTimeout(() => {
        touchTimer.current = null;
        dragState.current = {
          agentId, node, startX, startY,
          origLeft: parseInt(node.style.left) || 0,
          origTop: parseInt(node.style.top) || 0,
          nodeWidth: rect.width || 140,
          nodeHeight: rect.height || 56,
        };
        node.setPointerCapture(e.pointerId);
        node.classList.add('is-dragging');
      }, LONG_PRESS_MS);
      return;
    }

    // Mouse / pen: capture immediately.
    dragState.current = {
      agentId, node, startX, startY,
      origLeft: parseInt(node.style.left) || 0,
      origTop: parseInt(node.style.top) || 0,
      nodeWidth: rect.width || 140,
      nodeHeight: rect.height || 56,
    };
    node.setPointerCapture(e.pointerId);
    node.classList.add('is-dragging');
  }, []);

  const _onPointerMove = useCallback((e) => {
    // If a touch long-press timer is active, check for early movement
    // (scroll gesture) and cancel the drag.
    if (touchTimer.current) {
      const ds = dragState.current; // null during timer
      const sx = ds ? ds.startX : e.clientX;
      const sy = ds ? ds.startY : e.clientY;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > DRAG_HYST) {
        clearTimeout(touchTimer.current);
        touchTimer.current = null;
        dragState.current = null;
      }
      return;
    }

    if (!dragState.current) return;
    const { node, startX, startY, origLeft, origTop, nodeWidth } = dragState.current;
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;
    const canvas = canvasRef.current;
    const cw = canvas ? canvas.clientWidth / scale : 2000;
    const ch = canvas ? canvas.clientHeight / scale : 2000;
    // Keep at least MIN_VISIBLE_PX of the node visible on each side.
    const minX = -(nodeWidth - MIN_VISIBLE_PX);
    const maxX = cw - MIN_VISIBLE_PX;
    const maxY = ch - MIN_VISIBLE_PX;
    const newX = Math.max(minX, Math.min(origLeft + dx, maxX));
    const newY = Math.max(0, Math.min(origTop + dy, maxY));
    node.style.left = newX + 'px';
    node.style.top = newY + 'px';
  }, [scale]);

  const _onPointerUp = useCallback((e) => {
    // Clear any pending long-press timer.
    if (touchTimer.current) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
      dragState.current = null;
      return; // short tap — let onDblClick handle it
    }
    if (!dragState.current) return;
    dragState.current.node.releasePointerCapture(e.pointerId);
    dragState.current.node.classList.remove('is-dragging');
    dragState.current = null;
    _scheduleSave();
  }, [_scheduleSave]);

  // ── zoom handler ────────────────────────────────────────────────

  const _onWheel = useCallback((e) => {
    if (!e.ctrlKey) return; // Only zoom with Ctrl+Wheel.
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((s) => Math.max(0.3, Math.min(2, s + delta)));
    _scheduleSave();
  }, [_scheduleSave]);

  // ── render ──────────────────────────────────────────────────────

  return html`
    <div class="workspace-canvas" ref=${canvasRef}
         onPointerMove=${_onPointerMove}
         onPointerUp=${_onPointerUp}
         onWheel=${_onWheel}
         style=${{ transform: `scale(${scale}) translate(${offset.x}px, ${offset.y}px)`, transformOrigin: '0 0' }}>
      ${agents.map((agent, idx) => {
        const pos = getPosition(agent, idx);
        const selected = agent.id === activeAgentId;
        return html`
          <${AgentNode}
            key=${agent.id}
            agent=${agent}
            x=${pos.x}
            y=${pos.y}
            scale=${1}
            selected=${selected}
            pendingTasks=${agent.pendingTasks || 0}
            onDragStart=${_onDragStart(agent.id)}
            onDblClick=${onSelectAgent}
          />`;
      })}
      ${agents.length === 0 ? html`
        <div class="workspace-canvas-empty">
          暂无 agent 节点 — 在侧边栏文件夹中点击
          <span class="workspace-canvas-empty-hint">⊞</span>
          可在此画布中打开
        </div>
      ` : null}
    </div>`;
}
