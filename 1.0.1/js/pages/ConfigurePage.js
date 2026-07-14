// Settings page · summary lists of CLIs / Repos / Folders + General
// (port / work dir / theme). Each row has Edit + Delete; "+ Add"
// opens the same modal form used inline-from-launch.

import { html } from '../html.js';
import { useEffect, useState } from 'preact/hooks';
import {
  config, configDirty, accentColor, folders, workspaces, serverHealth,
  restartInFlight, themeMode,
  setAccentColor, ACCENT_DEFAULT, setThemeMode,
} from '../state.js';
import {
  api, loadConfig, loadWorkspaces, loadFolders,
  createCli, updateCli, deleteCli, setDefaultCli, testCli,
  createRepo, updateRepo, deleteRepo,
  createFolder, renameFolder, deleteFolder, reorderFolders,
  deleteWorkspace, restartBackend,
} from '../api.js';
import { setToast } from '../toast.js';
import { boosConfirm } from '../dialog.js';
import { keybindings, setBinding, resetBinding, ACTIONS, formatCombo } from '../keybindings.js';
import { T } from '../i18n.js';
import { KeybindingRecorder } from '../components/KeybindingRecorder.js';
import { Card } from '../components/Card.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { EntityFormModal } from '../components/EntityFormModal.js';
import { useDragSort } from '../components/useDragSort.js';
import { IconPlus, IconPencil, IconClose, IconTerminal, IconFolder, IconBranch, IconRefresh, IconChevronUp, IconChevronDown, IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor, IconSun, IconMoon, IconMonitor } from '../icons.js';
import { parseArgs, formatArgs } from '../util.js';

// Tokenize the free-form args fields into string[] before they hit
// the backend. Form values arrive as strings (text inputs) — backend
// stores arrays. parseArgs handles shell-style quoting so users can type
// `-Model "claude-opus-4-8"` or `-Path 'C:\some dir\bin'` and get sane
// argv splitting instead of a literal-quote token.
function tokenizeCliArgs(v) {
  const tok = (x) => typeof x === 'string' ? parseArgs(x) : x;
  return {
    ...v,
    args:             tok(v.args),
    resumeLatestArgs: tok(v.resumeLatestArgs),
    resumePickerArgs: tok(v.resumePickerArgs),
  };
}

// Type → smart defaults. Choosing a type in the form auto-fills resume args
// (and command if blank) so users don't need to remember the per-CLI flag.
const CLI_TYPE_DEFAULTS = {
  claude:  { command: 'claude',  resumeLatestArgs: '--continue',    resumePickerArgs: '--resume' },
  codex:   { command: 'codex',   resumeLatestArgs: 'resume --last', resumePickerArgs: 'resume' },
  copilot: { command: 'copilot', resumeLatestArgs: '--continue',    resumePickerArgs: '--resume' },
  other:   { resumeLatestArgs: '', resumePickerArgs: '' },
};

function cliFieldsFor({ creating } = {}) {
  return [
    { key: 'type', label: '类型', type: 'iconRadio', default: 'other', options: [
      { value: 'claude',  label: 'Claude CLI',     icon: html`<${IconClaudeColor} />` },
      { value: 'codex',   label: 'Codex CLI',      icon: html`<${IconCodexColor} />` },
      { value: 'copilot', label: 'GitHub Copilot', icon: html`<${IconCopilotColor} />` },
      { value: 'other',   label: '其他',          icon: html`<${IconTerminal} />` },
    ],
      // Type-change side effects. For known types we force the
      // folder-level resume args to the canonical template — those
      // fields are locked anyway so
      // there's no value in leaving stale strings around. For
      // type='other' we leave existing args alone so the user can
      // keep editing them. Name + command are only prefilled when
      // creating (don't clobber a saved CLI's name on edit).
      onChange: (v, next) => {
        const d = CLI_TYPE_DEFAULTS[v];
        if (!d) return null;
        const patch = {};
        if (v !== 'other') {
          patch.resumeLatestArgs = d.resumeLatestArgs;
          patch.resumePickerArgs = d.resumePickerArgs;
        }
        if (creating) {
          if (!next.command || !next.command.trim()) patch.command = d.command || '';
          if (!next.name || !next.name.trim()) {
            patch.name = v === 'claude' ? 'Claude Code'
                       : v === 'codex' ? 'OpenAI Codex'
                       : v === 'copilot' ? 'GitHub Copilot'
                       : '';
          }
        }
        return patch;
      },
    },
    { key: 'name', label: '名称', placeholder: '我的 CLI', required: true },
    { key: 'command', label: '命令', mono: true, placeholder: 'claude / codex / ...', required: true },
    { key: 'args', label: '参数', mono: true, placeholder: '',
      hint: '每次启动时使用。Shell 风格引号：-Model "claude-opus-4-8" 或 -Path \'C:\\some dir\\bin\'.' },
    { key: 'resumeLatestArgs', label: '恢复最新参数', mono: true, placeholder: '--continue',
      readOnly: (d) => d.type && d.type !== 'other',
      hint: (d) => d.type && d.type !== 'other'
        ? `锁定为 ${d.type} 类型的规范标志。将类型改为"其他"即可自定义。`
        : '在恢复行为设置为"最新"时使用。' },
    { key: 'resumePickerArgs', label: '恢复选择器参数', mono: true, placeholder: '--resume',
      readOnly: (d) => d.type && d.type !== 'other',
      hint: (d) => d.type && d.type !== 'other'
        ? `锁定为 ${d.type} 类型的规范标志。将类型改为"其他"即可自定义。`
        : '在恢复行为设置为"选择器"时使用。' },
    { key: 'shell', label: 'Shell', type: 'select', default: 'direct', options: [
      { value: 'direct', label: '直接 (真实 .exe / .cmd)' },
      { value: 'pwsh',   label: 'pwsh (PowerShell 别名和函数)' },
      { value: 'cmd',    label: 'cmd (doskey)' },
    ] },
  ];
}

function Section({ title, meta, children }) {
  return html`
    <section class="settings-section">
      <header class="settings-section-head">
        <h2 class="settings-section-title">${title}</h2>
        ${meta ? html`<p class="settings-section-meta">${meta}</p>` : null}
      </header>
      <div class="settings-section-body">${children}</div>
    </section>`;
}

// ── Field definitions shared with Launch picker ──────────────────────
// (CLI fields built lazily via cliFieldsFor — see above.)

const repoFields = [
  { key: 'name', label: '名称', placeholder: 'my-repo', autoFocus: true, required: true },
  { key: 'url',  label: 'URL', mono: true, placeholder: 'https://github.com/me/foo.git', required: true },
  { key: 'defaultSelected', label: '启动时预选', type: 'checkbox',
    hint: '在新会话的仓库选择器中自动勾选' },
];

const folderFields = [
  { key: 'name', label: '文件夹名称', placeholder: '工作 / 个人 / ...', autoFocus: true, required: true },
];

// ── Page ─────────────────────────────────────────────────────────────
export function ConfigurePage() {
  const cfg = config.value;
  const [edit, setEdit] = useState(null); // { kind, payload? }
  const [general, setGeneral] = useState(null);
  const [savedAt, setSavedAt] = useState('');

  const folderDnd = useDragSort(
    folders.value.map((f) => f.id),
    async (nextIds) => {
      try { await reorderFolders(nextIds); }
      catch (e) { setToast(e.message, 'error'); }
    },
  );

  useEffect(() => {
    if (cfg && !general) {
      setGeneral({
        workDir: cfg.workDir,
        editor: cfg.editor,
        resumeMode: cfg.resumeMode === 'picker' ? 'picker' : 'latest',
      });
    }
  }, [cfg]);

  if (!cfg || !general) return null;

  const saveGeneral = async (patch) => {
    const merged = { ...general, ...patch };
    setGeneral(merged);
    try {
      const saved = await api('PUT', '/api/config', {
        ...cfg,
        workDir: (merged.workDir || '').trim(),
        editor: (merged.editor || '').trim(),
        resumeMode: merged.resumeMode === 'picker' ? 'picker' : 'latest',
      });
      config.value = saved;
      setToast('已保存');
      await loadWorkspaces();
    } catch (e) { setToast(e.message, 'error'); }
  };

  const close = () => setEdit(null);

  return html`
    <${PageTitleBar} title="设置" />
    <div class="settings-scroll">

    <${Section} title="通用">
      <div class="config-grid">
        <div class="field">
          <span class="label">外观</span>
          <${ThemeToggle} />
        </div>
        <div class="field">
          <span class="label">主题色</span>
          <${AccentPicker} />
        </div>
        <div class="field">
          <span class="label">版本</span>
          <${VersionField} />
        </div>
        <div class="field">
          <span class="label">后端</span>
          <${RestartButton} />
        </div>
        <div class="field">
          <span class="label">恢复行为</span>
          <div class="seg" role="group" aria-label="恢复行为">
            ${[
              { id: 'latest', label: '恢复最新' },
              { id: 'picker', label: '恢复选择器' },
            ].map((o) => html`
              <button key=${o.id} type="button"
                      class=${`seg-btn${general.resumeMode === o.id ? ' is-active' : ''}`}
                      aria-pressed=${general.resumeMode === o.id}
                      onClick=${() => saveGeneral({ resumeMode: o.id })}>
                <span>${o.label}</span>
              </button>`)}
          </div>
        </div>
        <label class="field">
          <span class="label">编辑器</span>
          <input type="text" class="mono" value=${general.editor || ''}
                 placeholder="code"
                 onChange=${(e) => saveGeneral({ editor: e.target.value })} />
          <span class="hint">会话"在编辑器中打开"的命令。默认 <code>code</code> (VS Code)。可尝试 <code>cursor</code>、<code>code-insiders</code> 等。</span>
        </label>
      </div>
    </${Section}>

    <${Section} title="CLI" meta=${html`内置条目 (<code>claude</code>, <code>codex</code>, <code>copilot</code>) 会自动探测 PATH。`}>
      <${EntityList}
        kind="cli"
        addLabel="添加 CLI"
        items=${(cfg.clis || []).map((c) => {
          const tags = [];
          if (cfg.defaultCliId === c.id) tags.push({ label: '默认', tone: 'accent' });
          if (c.builtin) tags.push({ label: c.installed ? '已安装' : '未找到', tone: c.installed ? 'ok' : 'warn' });
          const Icon = IconForCliType(c.type);
          return {
            id: c.id,
            icon: html`<${Icon} />`,
            primary: c.name,
            secondary: html`<span class="mono">${c.command}${c.args?.length ? ' ' + formatArgs(c.args) : ''}</span>${c.shell && c.shell !== 'direct' ? html` · ${c.shell}` : null}`,
            badges: tags,
            undeletable: c.builtin,
            raw: c,
          };
        })}
        onAdd=${() => setEdit({ kind: 'cli-new' })}
        onEdit=${(it) => setEdit({ kind: 'cli-edit', payload: it.raw })}
        onDelete=${async (it) => {
          if (it.undeletable) return setToast(`「${it.primary}」是内置 CLI，无法删除`, 'error');
          if (cfg.clis.length === 1) return setToast('无法删除最后一个 CLI', 'error');
          const ok = await boosConfirm(`删除 CLI「${it.primary}」？`, { okLabel: '删除', danger: true });
          if (!ok) return;
          try { await deleteCli(it.id); setToast('已删除'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        onActivate=${async (it) => {
          if (cfg.defaultCliId === it.id) return;
          try { await setDefaultCli(it.id); setToast(`已设为默认 · ${it.primary}`); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="未配置 CLI。"
      />
    </${Section}>

    <${Section} title="仓库" meta="可在启动时克隆到新工作空间。">
      <${EntityList}
        kind="repo"
        addLabel="添加仓库"
        items=${(cfg.repos || []).map((r) => ({
          id: r.name,
          icon: html`<${IconBranch} />`,
          primary: r.name,
          secondary: html`<span class="mono">${r.url}</span>`,
          badge: r.defaultSelected ? '自动' : null,
          raw: r,
        }))}
        onAdd=${() => setEdit({ kind: 'repo-new' })}
        onEdit=${(it) => setEdit({ kind: 'repo-edit', payload: it.raw })}
        onDelete=${async (it) => {
          const ok = await boosConfirm(`从列表中移除仓库「${it.primary}」？`, { okLabel: '移除', danger: true });
          if (!ok) return;
          try { await deleteRepo(it.id); setToast('已移除'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="未配置仓库。"
      />
    </${Section}>

    <${Section} title="文件夹" meta="在侧栏中分组会话的分类。">
      <${EntityList}
        kind="folder"
        addLabel="添加文件夹"
        dnd=${folderDnd}
        items=${folders.value.map((f) => ({
          id: f.id,
          icon: html`<${IconFolder} />`,
          primary: f.name,
          secondary: null,
          raw: f,
        }))}
        onAdd=${() => setEdit({ kind: 'folder-new' })}
        onEdit=${(it) => setEdit({ kind: 'folder-edit', payload: it.raw })}
        onDelete=${async (it) => {
          const ok = await boosConfirm(`删除文件夹「${it.primary}」？其中的会话将移至未分类。`, { okLabel: '删除', danger: true });
          if (!ok) return;
          try { await deleteFolder(it.id); setToast('已删除'); }
          catch (e) { setToast(e.message, 'error'); }
        }}
        emptyHint="暂无文件夹。"
      />
    </${Section}>

    <${Section} title="工作空间"
                meta=${html`自动分配的工作目录下的 <code>ws-N</code> 文件夹。每个包含一个或多个仓库克隆。`}>
      <div class="config-grid">
        <label class="field">
          <span class="label">工作目录</span>
          <input type="text" value=${general.workDir}
                 onChange=${(e) => saveGeneral({ workDir: e.target.value })} />
        </label>
      </div>
      <${WorkspaceList} />
    </${Section}>

    <${Section} title="HR Agent"
                meta="自动招募与资产管理。启用后 HR Agent 定期扫描配置的资产路径。">
      <${HRAgentSection} />
    </${Section}>

    <${Section} title="键盘快捷键"
                meta="点击快捷键即可录制新组合键。按 Esc 取消。">
      <${KeybindingsList} />
    </${Section}>

    </div>

    ${edit?.kind === 'cli-new' ? html`
      <${EntityFormModal} title="新建 CLI" fields=${cliFieldsFor({ creating: true })}
        onClose=${close} submitLabel="创建"
        onTest=${(v) => testCli({ command: v.command, shell: v.shell, type: v.type })}
        onSubmit=${async (v) => {
          try { await createCli(tokenizeCliArgs(v)); setToast(`已创建 CLI · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'cli-edit' ? html`
      <${EntityFormModal} title=${`编辑 ${edit.payload.name}`} fields=${cliFieldsFor()}
        readOnlyKeys=${edit.payload.builtin ? ['type'] : []}
        initial=${{
          ...edit.payload,
          args: formatArgs(edit.payload.args),
          resumeLatestArgs: formatArgs(edit.payload.resumeLatestArgs),
          resumePickerArgs: formatArgs(edit.payload.resumePickerArgs),
        }}
        onClose=${close}
        onTest=${(v) => testCli({ command: v.command, shell: v.shell, type: v.type })}
        onSubmit=${async (v) => {
          try {
            await updateCli(edit.payload.id, tokenizeCliArgs(v));
            setToast('已保存');
          } catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'repo-new' ? html`
      <${EntityFormModal} title="新建仓库" fields=${repoFields}
        onClose=${close} submitLabel="添加"
        onSubmit=${async (v) => {
          try { await createRepo(v); setToast(`已添加仓库 · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'repo-edit' ? html`
      <${EntityFormModal} title=${`编辑 ${edit.payload.name}`} fields=${repoFields}
        initial=${edit.payload}
        onClose=${close}
        onSubmit=${async (v) => {
          try { await updateRepo(edit.payload.name, v); setToast('已保存'); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'folder-new' ? html`
      <${EntityFormModal} title="新建文件夹" fields=${folderFields}
        onClose=${close} submitLabel="创建"
        onSubmit=${async (v) => {
          try { await createFolder(v.name); await loadFolders(); setToast(`已创建文件夹 · ${v.name}`); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}

    ${edit?.kind === 'folder-edit' ? html`
      <${EntityFormModal} title=${`重命名 ${edit.payload.name}`} fields=${folderFields}
        initial=${edit.payload}
        onClose=${close}
        onSubmit=${async (v) => {
          try { await renameFolder(edit.payload.id, v.name.trim()); await loadFolders(); setToast('已重命名'); }
          catch (e) { setToast(e.message, 'error'); throw e; }
        }} />` : null}
  `;
}

// Generic "list of rows + Add button" used by all three sections.
function EntityList({ items, onAdd, onEdit, onDelete, onActivate, emptyHint, dnd, addLabel = '添加' }) {
  return html`
    <div class="entity-list">
      ${items.length === 0
        ? html`<div class="entity-empty">${emptyHint}</div>`
        : items.map((it) => {
          const rowProps = dnd ? dnd.rowProps(it.id) : {};
          const handleProps = dnd ? dnd.handleProps(it.id) : {};
          const badges = it.badges || (it.badge ? [{ label: it.badge, tone: 'accent' }] : []);
          return html`
          <div class=${`entity-row${dnd ? ' is-draggable' : ''}`} key=${it.id}
               ...${rowProps} ...${handleProps}>
            ${dnd ? html`<span class="entity-row-grip" aria-hidden="true">⋮⋮</span>` : null}
            <span class="entity-row-icon">${it.icon}</span>
            <span class="entity-row-main">
              <span class="entity-row-primary">
                ${it.primary}
                ${badges.map((b) => html`
                  <span class=${`entity-row-badge tone-${b.tone || 'accent'}`}>${b.label}</span>`)}
              </span>
              ${it.secondary ? html`<span class="entity-row-secondary">${it.secondary}</span>` : null}
            </span>
            <span class="entity-row-actions">
              ${onActivate ? html`
                <button class="entity-row-action" title="设为默认"
                        onClick=${() => onActivate(it)}>★</button>` : null}
              <button class="entity-row-action" title="编辑"
                      onClick=${() => onEdit(it)}><${IconPencil} /></button>
              ${it.undeletable ? null : html`
                <button class="entity-row-action danger" title="删除"
                        onClick=${() => onDelete(it)}><${IconClose} /></button>`}
            </span>
          </div>`;
        })}
      <button class="entity-add" type="button" onClick=${onAdd}>
        <span>${addLabel}</span>
      </button>
    </div>`;
}

// ── Workspace list ───────────────────────────────────────────────────
function WorkspaceList() {
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

// ── Accent picker (unchanged) ────────────────────────────────────────
const PRESETS = [
  { name: 'Ocean',         hex: '#2f6fa3' },
  { name: 'Claude copper', hex: '#b3614a' },
  { name: 'Anthropic ink', hex: '#1a1815' },
  { name: 'Forest',        hex: '#3f7a4a' },
  { name: 'Amber',         hex: '#c4892b' },
  { name: 'Berry',         hex: '#a44b78' },
  { name: 'Slate',         hex: '#4a5563' },
  { name: 'Crimson',       hex: '#b73f3f' },
];

function VersionField() {
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(true);
  const [upgrading, setUpgrading] = useState(false);

  const refresh = async (force = false) => {
    setChecking(true);
    try {
      const r = await api('GET', '/api/version' + (force ? '?refresh=1' : ''));
      setInfo(r);
    } catch (e) {
      setInfo({ error: e.message });
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => { refresh(false); }, []);

  const onUpgrade = async () => {
    if (!info?.updateAvailable) return;
    setUpgrading(true);
    try {
      const r = await api('POST', '/api/upgrade', { target: 'latest' });
      setToast(`升级到 v${info.latest} · 后端将重启`);
      if (r?.helperUrl) {
        setTimeout(() => { location.href = r.helperUrl; }, 300);
      } else if (r?.closeFrontend) {
        setTimeout(() => { try { window.close(); } catch {} }, 400);
      }
    } catch (e) {
      setUpgrading(false);
      setToast(e.message, 'error');
    }
  };

  const current = info?.current || serverHealth.value.version || '';
  const latest  = info?.latest;
  const updateAvailable = !!info?.updateAvailable;

  return html`
    <div class=${`version-card${updateAvailable ? ' has-update' : info?.error ? ' has-error' : ''}`}>
      <div class="version-card-main">
        <div class="version-card-current">
          <span class="version-card-label">已安装</span>
          <span class="version-card-version">v${current || '?'}</span>
          ${!updateAvailable && !info?.error && latest ? html`
            <span class="version-card-badge">最新</span>
          ` : null}
        </div>
        <div class="version-card-meta">
          ${info?.error
            ? html`<span class="version-card-error">无法连接 npm 仓库 · <code>${info.error}</code></span>`
            : updateAvailable
              ? html`有可用更新 · <span class="mono">v${latest}</span>`
              : latest
                ? `你使用的是最新版本。检查 npm 仓库（缓存 30 分钟）。`
                : '检查 npm 仓库（缓存 30 分钟）。'}
        </div>
      </div>
      <div class="version-card-actions">
        ${updateAvailable ? html`
          <button class="action primary" disabled=${upgrading} onClick=${onUpgrade}>
            ${upgrading ? '升级中…' : `升级到 v${latest}`}
          </button>
        ` : null}
        <button class="action version-card-check" disabled=${checking || upgrading} onClick=${() => refresh(true)}>
          <${IconRefresh} /> ${checking ? '检查中…' : '立即检查'}
        </button>
      </div>
    </div>
  `;
}

function RestartButton() {
  const onClick = async () => {
    const ok = await boosConfirm(
      '重启 boos 后端？活跃会话将被终止，下次启动时重新连接。',
      { okLabel: '重启', danger: true });
    if (!ok) return;
    // Drop the fullscreen RestartOverlay BEFORE firing /api/restart —
    // the request itself takes ~0ms (response is "ok, restarting") but
    // the server then begins tearing PTYs down. If we wait for the
    // response before opening the overlay, the user gets a frozen
    // button + half-a-second of confusion.
    const prevPid = serverHealth.value.pid || null;
    restartInFlight.value = { startedAt: Date.now(), prevPid };
    try {
      const r = await restartBackend();
      if (r?.closeFrontend) {
        // Backend respawn will pop a fresh browser window — close this
        // one so the user isn't stuck on the OfflineBanner during the
        // ~3s downtime. window.close() only fires in script-opened
        // windows (Edge --app=); regular tabs ignore it and stay open,
        // which is the right behavior for them.
        setTimeout(() => { try { window.close(); } catch {} }, 400);
      }
      // RestartOverlay self-dismisses once /api/health reports a fresh
      // pid, so no further work here. If the new backend never comes
      // back, the overlay has its own 30s safety timeout + OfflineBanner
      // takes over.
    } catch (e) {
      restartInFlight.value = null;
      setToast(e.message, 'error');
    }
  };
  return html`
    <div class="restart-button-wrap">
      <button class="action" onClick=${onClick}>重启后端</button>
    </div>
  `;
}

function ThemeToggle() {
  const mode = themeMode.value;
  const opts = [
    { id: 'light', label: '浅色', icon: IconSun },
    { id: 'dark', label: '深色', icon: IconMoon },
    { id: 'system', label: '系统', icon: IconMonitor },
  ];
  return html`
    <div class="seg" role="group" aria-label="外观">
      ${opts.map((o) => html`
        <button key=${o.id} type="button"
                class=${`seg-btn${mode === o.id ? ' is-active' : ''}`}
                aria-pressed=${mode === o.id}
                onClick=${() => setThemeMode(o.id)}>
          <${o.icon} /><span>${o.label}</span>
        </button>`)}
    </div>`;
}

function AccentPicker() {
  const current = (accentColor.value || '').toLowerCase();
  const matchedPreset = PRESETS.find((p) => p.hex.toLowerCase() === current);
  const [customOpen, setCustomOpen] = useState(!matchedPreset);
  const [text, setText] = useState(current);
  useEffect(() => { setText(current); }, [current]);

  const pickPreset = (hex) => {
    setAccentColor(hex);
    setCustomOpen(false);
  };
  const onText = (e) => {
    const v = e.target.value.trim();
    setText(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setAccentColor(v);
  };
  return html`
    <div class="accent-picker">
      <div class="accent-chips">
        ${PRESETS.map((p) => {
          const active = current === p.hex.toLowerCase();
          return html`
            <button key=${p.hex} type="button"
                    class=${`accent-chip${active ? ' is-active' : ''}`}
                    style=${`--c:${p.hex}`}
                    title=${p.hex}
                    onClick=${() => pickPreset(p.hex)}>
              <span class="accent-chip-dot" aria-hidden="true"></span>
              <span class="accent-chip-name">${p.name}</span>
            </button>`;
        })}
        <button type="button"
                class=${`accent-chip accent-chip-custom${customOpen ? ' is-open' : ''}${!matchedPreset ? ' is-active' : ''}`}
                style=${!matchedPreset ? `--c:${current}` : ''}
                onClick=${() => setCustomOpen((v) => !v)}>
          ${!matchedPreset
            ? html`<span class="accent-chip-dot" aria-hidden="true"></span>`
            : html`<span class="accent-chip-plus" aria-hidden="true">+</span>`}
          <span class="accent-chip-name">自定义</span>
        </button>
      </div>
      ${customOpen ? html`
        <div class="accent-custom">
          <input type="color" value=${current}
                 onInput=${(e) => setAccentColor(e.target.value)} />
          <input type="text" class="accent-hex mono" value=${text}
                 spellcheck="false" maxlength="7"
                 onInput=${onText} placeholder="#rrggbb" />
          <button type="button" class="accent-reset"
                  onClick=${() => { setAccentColor(ACCENT_DEFAULT); setCustomOpen(false); }}>
            重置
          </button>
        </div>` : null}
    </div>`;
}


// ── Keyboard shortcuts ───────────────────────────────────────────────
const ACTION_ICONS = {
  'session-next':      IconChevronDown,
  'session-prev':      IconChevronUp,
  'session-move-down': IconChevronDown,
  'session-move-up':   IconChevronUp,
};

// ── HR Agent section ────────────────────────────────────────────────
// TODO(#66): replace mock data with GET /api/hr/roles once backend is ready.

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

function HRAgentSection() {
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

function KeybindingsList() {
  const map = keybindings.value;
  const [recording, setRecording] = useState(null); // actionId or null

  return html`
    <div class="entity-list">
      ${Object.entries(ACTIONS).map(([id, def]) => {
        const combo = map[id];
        const isCustom = combo !== def.defaultCombo;
        const Icon = ACTION_ICONS[id] || IconTerminal;
        return html`
          <div class="entity-row" key=${id}>
            <span class="entity-row-icon"><${Icon} /></span>
            <span class="entity-row-main">
              <span class="entity-row-primary">
                ${def.label}
                <span class="entity-row-badge tone-accent">${formatCombo(combo)}</span>
              </span>
              <span class="entity-row-secondary">
                <span class="mono">${id}</span> · 默认 <span class="mono">${formatCombo(def.defaultCombo)}</span>
              </span>
            </span>
            <span class="entity-row-actions">
              <button class="entity-row-action" title="重新绑定"
                      onClick=${() => setRecording(id)}><${IconPencil} /></button>
              ${isCustom ? html`
                <button class="entity-row-action" title="重置为默认"
                        onClick=${() => resetBinding(id)}><${IconRefresh} /></button>` : null}
            </span>
          </div>`;
      })}
    </div>
    ${recording ? html`
      <${KeybindingRecorder}
        actionLabel=${ACTIONS[recording]?.label || recording}
        onCommit=${(combo) => { setBinding(recording, combo); setRecording(null); }}
        onCancel=${() => setRecording(null)} />` : null}`;
}
