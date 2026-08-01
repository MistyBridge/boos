// Sprint 35: Extracted from ConfigurePage.js — Workspace config (PM/PMO) + list.
// Used by ConfigurePage in the "工作空间" and "Workspace 配置" sections.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import { workspaces } from '../state.js';
import {
  getWorkspaceConfig, setWorkspacePM, clearWorkspacePM,
  setWorkspacePMO, clearWorkspacePMO, setWorkspaceAutoSupervisor,
  deleteWorkspace, loadWorkspaces,
} from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { IconClose, IconFolder } from '../icons.js';

// ── Sprint 32: Workspace config (PM/PMO + auto-supervisor) ────────────

export function WorkspaceConfigSection() {
  const [wsCfg, setWsCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pmInput, setPmInput] = useState('');
  const [pmoInput, setPmoInput] = useState('');
  // TODO: read from config signal when multi-workspace is supported
  const ws = 'boos';

  useEffect(() => {
    getWorkspaceConfig(ws).then((cfg) => {
      setWsCfg(cfg);
      setPmInput(cfg.pm_uid || '');
      setPmoInput(cfg.pmo_uid || '');
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return html`<div class="entity-empty">加载中…</div>`;
  if (!wsCfg) return html`<div class="entity-empty">无法加载 workspace 配置。</div>`;

  const refresh = async () => {
    setLoading(true);
    try {
      const cfg = await getWorkspaceConfig(ws);
      setWsCfg(cfg);
      setPmInput(cfg.pm_uid || '');
      setPmoInput(cfg.pmo_uid || '');
    } catch {}
    setLoading(false);
  };

  const handleSetPM = async () => {
    const uid = pmInput.trim();
    if (!uid || busy) return;
    setBusy(true);
    try {
      await setWorkspacePM(ws, uid);
      setToast('PM 已指派');
      await refresh();
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleClearPM = async () => {
    if (busy) return;
    setBusy(true);
    try { await clearWorkspacePM(ws); setToast('PM 已移除'); await refresh(); }
    catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleSetPMO = async () => {
    const uid = pmoInput.trim();
    if (!uid || busy) return;
    setBusy(true);
    try {
      await setWorkspacePMO(ws, uid);
      setToast('PMO 已指派');
      await refresh();
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleClearPMO = async () => {
    if (busy) return;
    setBusy(true);
    try { await clearWorkspacePMO(ws); setToast('PMO 已移除'); await refresh(); }
    catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleToggleAutoSup = async () => {
    if (busy) return;
    const next = !wsCfg.auto_supervisor_enabled;
    setBusy(true);
    try {
      await setWorkspaceAutoSupervisor(ws, next);
      // P1 fix: setWsCfg AFTER await, not before — avoids stale UI on failure
      setWsCfg((prev) => ({ ...prev, auto_supervisor_enabled: next }));
      setToast(next ? 'Auto-Supervisor 已启用' : 'Auto-Supervisor 已禁用');
    } catch (e) { setToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return html`
    <div class="config-grid">
      <div class="field">
        <span class="label">PM (Project Manager)</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" class="mono" value=${pmInput}
                 onInput=${(e) => setPmInput(e.target.value)}
                 placeholder="Agent UID"
                 disabled=${busy}
                 style="flex:1;font-size:12px;" />
          <button class="action small primary" onClick=${handleSetPM} disabled=${busy}>指派</button>
          ${wsCfg.pm_uid ? html`
            <button class="action small subtle" onClick=${handleClearPM} disabled=${busy}>× 移除</button>
          ` : null}
        </div>
        <span class="hint">
          ${wsCfg.pm_uid
            ? html`当前 PM: <code>${wsCfg.pm_uid}</code>`
            : '未指派 PM。每工作区最多 1 名。'}
        </span>
      </div>

      <div class="field">
        <span class="label">PMO (Project Management Office)</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" class="mono" value=${pmoInput}
                 onInput=${(e) => setPmoInput(e.target.value)}
                 placeholder="Agent UID"
                 disabled=${busy}
                 style="flex:1;font-size:12px;" />
          <button class="action small primary" onClick=${handleSetPMO} disabled=${busy}>指派</button>
          ${wsCfg.pmo_uid ? html`
            <button class="action small subtle" onClick=${handleClearPMO} disabled=${busy}>× 移除</button>
          ` : null}
        </div>
        <span class="hint">
          ${wsCfg.pmo_uid
            ? html`当前 PMO: <code>${wsCfg.pmo_uid}</code>`
            : '未指派 PMO。需手动创建 PMO session 后指派。PMO 不像 HR 一样自动注册。'}
        </span>
      </div>

      <div class="field">
        <span class="label">Auto-Supervisor 自动停滞检测</span>
        <div class="seg" role="group" aria-label="Auto-Supervisor">
          <button type="button"
                  class=${`seg-btn${wsCfg.auto_supervisor_enabled !== false ? ' is-active' : ''}`}
                  onClick=${wsCfg.auto_supervisor_enabled !== false ? null : handleToggleAutoSup}
                  disabled=${busy}>
            <span>✓ 已启用</span>
          </button>
          <button type="button"
                  class=${`seg-btn${wsCfg.auto_supervisor_enabled === false ? ' is-active' : ''}`}
                  onClick=${wsCfg.auto_supervisor_enabled === false ? null : handleToggleAutoSup}
                  disabled=${busy}>
            <span>已禁用</span>
          </button>
        </div>
        <span class="hint">代码层后台轮询：5 分钟检测一次停滞状态。所有 worker 空闲且有未完成任务 → 自动唤醒 PM。</span>
      </div>
    </div>`;
}

// ── Workspace list ───────────────────────────────────────────────────

export function WorkspaceList() {
  const ws = workspaces.value || [];
  const inUseBy = '会话';
  if (ws.length === 0) {
    return html`<div class="entity-empty">暂无工作空间 — 启动时会自动创建。</div>`;
  }
  const onDelete = async (w) => {
    if (w.inUse) return setToast(`「${w.name}」正被 ${inUseBy} 使用`, 'error');
    const ok = await boosConfirm(
      `删除工作空间「${w.name}」？这将删除目录及其中的所有仓库克隆。`,
      { okLabel: '删除', danger: true },
    );
    if (!ok) return;
    try {
      await deleteWorkspace(w.name);
      await loadWorkspaces();
      setToast(`已删除 · ${w.name}`);
    } catch (e) { setToast(e.message, 'error'); }
  };
  return html`
    <div class="entity-list">
      ${ws.map((w) => {
        const repoCount = (w.repos || []).filter((r) => r.exists).length;
        return html`
        <div class="entity-row" key=${w.path}>
          <span class="entity-row-icon"><${IconFolder} /></span>
          <span class="entity-row-main">
            <span class="entity-row-primary">
              ${w.name}
              ${w.inUse ? html`<span class="entity-row-badge tone-warn">使用中</span>` : null}
            </span>
            <span class="entity-row-secondary">
              <span class="mono">${w.path}</span>
              ${repoCount > 0 ? html` · ${repoCount} ${repoCount === 1 ? '个仓库' : '个仓库'}` : null}
            </span>
          </span>
          <span class="entity-row-actions">
            <button class=${`entity-row-action danger${w.inUse ? ' is-disabled' : ''}`}
                    title=${w.inUse ? `正被 ${inUseBy} 使用` : '删除'}
                    disabled=${w.inUse}
                    onClick=${() => onDelete(w)}><${IconClose} /></button>
          </span>
        </div>`;
      })}
    </div>`;
}
