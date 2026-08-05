// Sprint 37: GoalRouterPage — internal router for goal sub-pages.
// Manages navigation between GoalListPage → NewGoalPage → GoalDetailPage.
// Also hosts the DagNodeModal for node detail views.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { GoalListPage } from './GoalListPage.js';
import { NewGoalPage } from './NewGoalPage.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { DagNodeModal } from '../components/DagNodeModal.js';

export function GoalRouterPage() {
  const [page, setPage] = useState('list');   // 'list' | 'new' | 'goal-detail'
  const [goalId, setGoalId] = useState(null);
  const [nodeTask, setNodeTask] = useState(null);  // for DagNodeModal

  const handleNavigate = (target, id) => {
    setPage(target);
    if (id) setGoalId(id);
    if (target === 'list') { setGoalId(null); setNodeTask(null); }
  };

  const handleOpenNode = (task) => { setNodeTask(task); };

  return html`
    ${page === 'list' ? html`<${GoalListPage} onNavigate=${handleNavigate} />` : null}
    ${page === 'new' ? html`<${NewGoalPage} onNavigate=${handleNavigate} />` : null}
    ${page === 'goal-detail' && goalId ? html`<${GoalDetailPage} goalId=${goalId} onNavigate=${handleNavigate} onOpenNode=${handleOpenNode} />` : null}
    ${nodeTask ? html`<${DagNodeModal} task=${nodeTask} onClose=${() => setNodeTask(null)} />` : null}
  `;
}
