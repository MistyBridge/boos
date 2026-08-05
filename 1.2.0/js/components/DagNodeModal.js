// Sprint 37: DagNodeModal — detailed view of a DAG task node.
// 4 tabs: Detail / Questions / Feedback / History.
// Used by CompositeDagGraph node click → opens as overlay modal.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { addDagQuestions, answerDagQuestion } from '../api.js';
import { setToast } from '../toast.js';

const TAB_KEYS = ['detail', 'questions', 'feedback', 'history'];
const TAB_LABELS = { detail: '详情', questions: '选择题', feedback: '反馈', history: '历史' };

export function DagNodeModal({ task, onClose }) {
  const [tab, setTab] = useState('detail');
  const [answers, setAnswers] = useState({});
  const [customAnswer, setCustomAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  if (!task) return null;

  const questions = task.review_questions || [];
  const history = task.review_history || [];
  const feedback = task.feedback || [];

  const handleAnswer = async (questionId, answer) => {
    setBusy(true);
    try {
      const r = await answerDagQuestion(questionId, { answer });
      if (r.ok) {
        setAnswers((prev) => ({ ...prev, [questionId]: answer }));
        setToast('回答已提交');
      } else {
        setToast(r.error || '回答失败');
      }
    } catch (e) { setToast(e.message || '网络错误'); }
    setBusy(false);
  };

  const handleCustomAnswer = async (questionId) => {
    if (!customAnswer.trim()) return;
    handleAnswer(questionId, customAnswer.trim());
    setCustomAnswer('');
  };

  const handleSkip = async (questionId) => {
    handleAnswer(questionId, '__skipped__');
  };

  // ── Tab content renderers ──

  const renderDetail = () => html`
    <div style="font-size:13px;line-height:1.6;">
      <div style="margin-bottom:var(--s-2);">
        <span style="color:var(--ink-muted);font-size:11px;">Task ID</span><br/>
        <span class="mono" style="font-size:12px;">${task.task_id || '-'}</span>
      </div>
      <div style="margin-bottom:var(--s-2);">
        <span style="color:var(--ink-muted);font-size:11px;">标题</span><br/>
        <span style="font-weight:600;">${task.title || '-'}</span>
      </div>
      <div style="margin-bottom:var(--s-2);">
        <span style="color:var(--ink-muted);font-size:11px;">描述</span><br/>
        <span>${task.description || '无描述'}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-2);margin-bottom:var(--s-2);">
        <div><span style="color:var(--ink-muted);font-size:11px;">执行者</span><br/><span>${task.executor || task.executor_name || '-'}</span></div>
        <div><span style="color:var(--ink-muted);font-size:11px;">审查者</span><br/><span>${task.reviewer || task.reviewer_name || '-'}</span></div>
        <div><span style="color:var(--ink-muted);font-size:11px;">发布者</span><br/><span>${task.publisher || task.publisher_name || '-'}</span></div>
        <div><span style="color:var(--ink-muted);font-size:11px;">状态</span><br/>
          <span class="task-status-chip ${task.status === 'approved' ? 'task-status-done' : task.status === 'active' ? 'task-status-active' : 'task-status-pending'}">${task.status || 'unknown'}</span>
        </div>
      </div>
      ${task.dependencies && task.dependencies.length > 0 ? html`
        <div style="margin-bottom:var(--s-2);">
          <span style="color:var(--ink-muted);font-size:11px;">依赖</span><br/>
          <span class="mono" style="font-size:11px;">${task.dependencies.map((d) => typeof d === 'string' ? d : d.title || d.task_id).join(', ')}</span>
        </div>
      ` : null}
      ${task.acceptance_criteria ? html`
        <div style="margin-bottom:var(--s-2);">
          <span style="color:var(--ink-muted);font-size:11px;">验收标准</span><br/>
          <span>${task.acceptance_criteria}</span>
        </div>
      ` : null}
    </div>
  `;

  const renderQuestions = () => {
    if (questions.length === 0) {
      return html`<p style="font-size:13px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">暂无选择题。</p>`;
    }
    return html`
      <div style="font-size:13px;">
        ${questions.map((q) => {
          const qId = q.question_id || q.id;
          const answered = answers[qId];
          const opts = q.options || [];
          return html`
            <div key=${qId} style="margin-bottom:var(--s-3);padding-bottom:var(--s-3);border-bottom:1px solid var(--border);">
              <p style="font-weight:600;margin-bottom:var(--s-2);">${q.question || q.title}</p>
              ${answered ? html`
                <p style="color:var(--green);font-size:12px;">已回答: ${answered === '__skipped__' ? '已跳过' : answered}</p>
              ` : html`
                <div style="display:flex;flex-wrap:wrap;gap:var(--s-1);margin-bottom:var(--s-2);">
                  ${opts.map((opt) => html`
                    <button class="action subtle" style="font-size:12px;"
                            onClick=${() => handleAnswer(qId, opt)} disabled=${busy}>
                      ${opt}
                    </button>
                  `)}
                </div>
                <div style="display:flex;gap:var(--s-1);align-items:center;">
                  <input type="text" class="text-input" placeholder="以上皆不是 — 自定义答案…"
                         value=${customAnswer} onInput=${(e) => setCustomAnswer(e.target.value)}
                         style="flex:1;font-size:12px;" />
                  <button class="action subtle" style="font-size:12px;"
                          onClick=${() => handleCustomAnswer(qId)} disabled=${busy || !customAnswer.trim()}>
                    提交
                  </button>
                  <button class="action subtle" style="font-size:12px;"
                          onClick=${() => handleSkip(qId)} disabled=${busy}>
                    跳过
                  </button>
                </div>
              `}
            </div>`;
        })}
      </div>
    `;
  };

  const renderFeedback = () => {
    if (feedback.length === 0) {
      return html`<p style="font-size:13px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">暂无反馈。</p>`;
    }
    return html`
      <div style="font-size:13px;">
        ${feedback.map((fb, i) => html`
          <div key=${i} style="padding:var(--s-2);margin-bottom:var(--s-2);background:var(--bg);border-radius:6px;">
            <div style="font-size:11px;color:var(--ink-muted);margin-bottom:2px;">${fb.from || '未知'} · ${fb.at ? new Date(fb.at).toLocaleString() : ''}</div>
            <div>${fb.message || fb.content || ''}</div>
          </div>
        `)}
      </div>
    `;
  };

  const renderHistory = () => {
    if (history.length === 0) {
      return html`<p style="font-size:13px;color:var(--ink-muted);text-align:center;padding:var(--s-3);">暂无修改历史。</p>`;
    }
    return html`
      <div style="font-size:13px;">
        ${history.map((h, i) => html`
          <div key=${i} style="padding:var(--s-2);margin-bottom:var(--s-2);background:var(--bg);border-radius:6px;">
            <div style="font-size:11px;color:var(--ink-muted);margin-bottom:2px;">${h.at ? new Date(h.at).toLocaleString() : ''}</div>
            <div class="mono" style="font-size:11px;white-space:pre-wrap;">${typeof h === 'string' ? h : JSON.stringify(h, null, 2)}</div>
          </div>
        `)}
        ${task.force_modified_at ? html`
          <div style="font-size:11px;color:var(--red);">Force modified at: ${new Date(task.force_modified_at).toLocaleString()}</div>
        ` : null}
      </div>
    `;
  };

  return html`
    <div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal-container" style="max-width:640px;max-height:80vh;" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span style="font-weight:600;font-size:14px;">${task.title || task.task_id || '节点详情'}</span>
          <button class="action subtle" onClick=${onClose} style="padding:2px 8px;font-size:16px;">×</button>
        </div>

        <!-- Tabs -->
        <div class="decisions-filter" style="padding:0 var(--s-3);margin-bottom:var(--s-3);">
          ${TAB_KEYS.map((k) => html`
            <button class="decision-filter-tab ${tab === k ? 'is-active' : ''}" onClick=${() => setTab(k)}>
              ${TAB_LABELS[k]}
            </button>
          `)}
        </div>

        <!-- Tab content -->
        <div style="padding:0 var(--s-3) var(--s-3);overflow-y:auto;max-height:50vh;">
          ${tab === 'detail'    ? renderDetail()    : null}
          ${tab === 'questions' ? renderQuestions() : null}
          ${tab === 'feedback'  ? renderFeedback()  : null}
          ${tab === 'history'   ? renderHistory()   : null}
        </div>
      </div>
    </div>`;
}
