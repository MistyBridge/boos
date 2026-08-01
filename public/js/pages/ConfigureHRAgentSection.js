// Sprint 35: Extracted from ConfigurePage.js — HR Agent recruitment + asset management.
// Used by ConfigurePage in the "HR Agent" section.
// TODO(#66): replace mock data with GET /api/hr/roles once backend is ready.

import { html } from '../html.js';
import { useState } from 'preact/hooks';
import { IconTerminal } from '../icons.js';

// ── Local storage helpers ────────────────────────────────────────────

const HR_LS_KEY = 'boos.hr-config';

function loadHRConfig() {
  try {
    const raw = localStorage.getItem(HR_LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { enabled: false, roles: [], log: [] };
}

function saveHRConfig(cfg) {
  try { localStorage.setItem(HR_LS_KEY, JSON.stringify(cfg)); } catch {}
}

// Mock role list — will be replaced by GET /api/hr/roles.
const MOCK_ROLES = [
  { id: 'frontend',   name: '前端工程师',   skill: 'Preact/xterm.js/CSS' },
  { id: 'backend',    name: '后端工程师',   skill: 'Node.js/Express/PTY' },
  { id: 'platform',   name: '平台集成工程师', skill: 'MCP/SSE/跨平台' },
  { id: 'qa',         name: 'QA/可靠性工程师', skill: '测试/CI/压测' },
];

// Mock recruitment log entries.
const MOCK_LOG = [
  { roleId: 'frontend', agentName: '前端工程师',    status: 'active',  at: Date.now() - 3600000 },
  { roleId: 'platform', agentName: '平台集成工程师', status: 'hired',   at: Date.now() - 7200000 },
  { roleId: 'qa',       agentName: 'QA/可靠性工程师', status: 'pending', at: Date.now() - 86400000 },
];

const STATUS_MAP = {
  active:  { label: '运行中', cls: 'is-running' },
  hired:   { label: '已就职', cls: 'is-stopped' },
  pending: { label: '招募中', cls: '' },
};

// ── HRAgentSection ────────────────────────────────────────────────────

export function HRAgentSection() {
  const [cfg, setCfg] = useState(loadHRConfig);

  const toggleEnabled = () => {
    const next = { ...cfg, enabled: !cfg.enabled };
    setCfg(next);
    saveHRConfig(next);
  };

  const roles = cfg.roles.length ? cfg.roles : MOCK_ROLES;
  const hrLog = cfg.log.length ? cfg.log : MOCK_LOG;

  return html`
    <div class="config-grid">
      <div class="field">
        <span class="label">状态</span>
        <div class="seg" role="group" aria-label="HR Agent 状态">
          <button type="button"
                  class=${`seg-btn${cfg.enabled ? ' is-active' : ''}`}
                  aria-pressed=${cfg.enabled}
                  onClick=${toggleEnabled}>
            <span>${cfg.enabled ? '✓ 已启用' : '已禁用'}</span>
          </button>
        </div>
        <span class="hint">
          ${cfg.enabled
            ? 'HR Agent 将定期扫描资产路径并管理角色招募。'
            : '启用后自动扫描资产并管理多 Agent 团队。'}
        </span>
      </div>
    </div>

    <div class="config-grid" style="margin-top: var(--s-4)">
      <div class="field">
        <span class="label">可用角色</span>
        <span class="hint">
          ⚠ API 待接入 — 当前为示例数据。后端就位后将展示 GET /api/hr/roles 返回的实际角色列表。
        </span>
        <div class="entity-list">
          ${roles.map((r) => html`
            <div class="entity-row" key=${r.id}>
              <span class="entity-row-icon"><${IconTerminal} /></span>
              <span class="entity-row-main">
                <span class="entity-row-primary">${r.name}</span>
                <span class="entity-row-secondary">
                  <span class="mono">${r.id}</span> · ${r.skill}
                </span>
              </span>
              <span class="entity-row-actions">
                <span class="entity-row-badge tone-accent">就绪</span>
              </span>
            </div>
          `)}
        </div>
      </div>
    </div>

    <div class="config-grid" style="margin-top: var(--s-4)">
      <div class="field">
        <span class="label">招募日志 · 最近 ${hrLog.length} 条</span>
        <span class="hint">⚠ API 待接入 — 当前为示例数据。</span>
        <div class="entity-list">
          ${hrLog.map((entry, idx) => {
            const st = STATUS_MAP[entry.status] || { label: entry.status, cls: '' };
            return html`
              <div class="entity-row" key=${idx}>
                <span class=${`entity-row-icon ${st.cls}`}>
                  <span class="tree-dot ${st.cls}"></span>
                </span>
                <span class="entity-row-main">
                  <span class="entity-row-primary">
                    ${entry.agentName}
                    <span class="entity-row-badge ${st.cls}">${st.label}</span>
                  </span>
                  <span class="entity-row-secondary">
                    <span class="mono">${entry.roleId}</span> · ${(() => {
                      const d = new Date(entry.at);
                      return d.toLocaleString('zh-CN', {
                        month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
                      });
                    })()}
                  </span>
                </span>
              </div>`;
          })}
        </div>
      </div>
    </div>`;
}
