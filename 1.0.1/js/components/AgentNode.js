// Single agent node on the workspace canvas.
// Shows agent name + CLI icon inside a card, with a semi-transparent
// session-title overlay above. Colour indicates activity:
//   green pulsing = working   gray = idle   dark gray = exited

import { html } from '../html.js';
import { IconForCliType, IconTerminal } from '../icons.js';

/**
 * @param {{ agent: { id:string, title:string, activity:string, cliType?:string },
 *            x: number, y: number, scale: number, selected: boolean,
 *            onDragStart: (e:PointerEvent) => void, onDblClick: (uid:string) => void }} props
 */
export function AgentNode({ agent, x, y, scale, selected, onDragStart, onDblClick }) {
  const activity = agent.activity || 'unknown';
  const isWorking = activity === 'working';
  const isExited = activity === 'exited' || (agent.status && agent.status !== 'running');
  const Icon = IconForCliType(agent.cliType) || IconTerminal;
  const displayTitle = agent.title || agent.id.slice(0, 12);

  const statusClass = isWorking ? 'is-working'
    : isExited ? 'is-exited'
    : 'is-idle';

  const hasScale = scale && scale !== 1;
  const style = `left:${x}px;top:${y}px;${hasScale ? `transform:scale(${scale})` : ''}`;

  return html`
    <div class=${`agent-node ${statusClass}${selected ? ' is-selected' : ''}`}
         style=${style}
         data-agent-id=${agent.id}
         onDblClick=${() => onDblClick(agent.id)}
         onPointerDown=${onDragStart}>
      <div class="agent-node-title">${displayTitle}</div>
      <div class="agent-node-body">
        <span class="agent-node-icon"><${Icon} /></span>
        <span class="agent-node-name">${displayTitle}</span>
      </div>
      <div class="agent-node-status-dot"></div>
    </div>`;
}
