// Launch page. ChatGPT-style centered composer with custom popover
// pickers for CLI / Folder / Repos. Each picker shares the unified
// PickerPanel component and can inline-create new entries.

import { html } from '../html.js';
import { useState, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { config, folders, selectSession, selectTab } from '../state.js';
import { createCli, createFolder, createRepo, refreshAll } from '../api.js';
import { setToast } from '../toast.js';
import { streamNewSession, resetProgress } from '../streaming.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { ProgressList } from '../components/ProgressList.js';
import { Modal } from '../components/Modal.js';
import { PickerPanel } from '../components/Picker.js';
import { DirectoryPicker } from '../components/DirectoryPicker.js';
import { LoadSessionModal } from '../components/LoadSessionModal.js';
import { BrandMark, IconTerminal, IconFolder, IconFolderOpen, IconBranch, IconChevronDown, IconForCliType, IconClaudeColor, IconCodexColor, IconCopilotColor, IconSparkle, IconWorkspace } from '../icons.js';
import { loadLaunchState, saveLaunchState } from '../launchState.js';
import { T } from '../i18n.js';

const ROOT_ID = 'newSessionProgress';
const selectedRepos = signal(new Set());

function initRepoSelection(repos, saved) {
  const valid = new Set(repos.map((r) => r.name));
  const sel = new Set();
  // Start from the persisted selection (last-used picks), keeping only
  // repos that still exist.
  if (saved && Array.isArray(saved.repos)) {
    for (const n of saved.repos) if (valid.has(n)) sel.add(n);
  }
  // Auto-check any repo whose "pre-select on launch" default is newly
  // active — i.e. it wasn't a default the last time we saved. This
  // covers both a brand-new default repo and an existing repo the user
  // just flipped to default in Configure. A default the user previously
  // unchecked stays unchecked (it's an old default, already in
  // knownDefaults). With no saved knownDefaults (fresh user / old
  // state), every default applies.
  const knownDefaults = saved && Array.isArray(saved.knownDefaults)
    ? new Set(saved.knownDefaults) : null;
  for (const r of repos) {
    if (r.defaultSelected && (knownDefaults === null || !knownDefaults.has(r.name))) {
      sel.add(r.name);
    }
  }
  selectedRepos.value = sel;
}

function LaunchHero() {
  const cfg = config.value || {};
  const clis = cfg.clis || [];
  const repos = cfg.repos || [];
  const defaultCli = cfg.defaultCliId || clis[0]?.id || '';
  const saved = loadLaunchState();

  // Initial values pull from localStorage first (last-used picks),
  // then fall back to config defaults. cliId is validated below in
  // the useEffect once `clis` arrives.
  const [cliId, setCliId] = useState(saved?.cliId || defaultCli);
  const [folderId, setFolderId] = useState(saved?.folderId || '');
  const [mode, setMode] = useState(saved?.mode === 'cwd' ? 'cwd' : 'auto');
  const [cwd, setCwd] = useState(saved?.cwd || ''); // only used when mode === 'cwd'
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [openPicker, setOpenPicker] = useState(null); // 'cli' | 'folder' | 'workdir' | null
  const [showLoad, setShowLoad] = useState(false);    // "Load existing session" modal

  // If config arrives after first render (cliId === '') OR the saved
  // cli was removed, snap to the current default.
  useEffect(() => {
    if (!clis.length) return;
    if (!cliId || !clis.find((c) => c.id === cliId)) {
      setCliId(defaultCli);
    }
  }, [defaultCli, clis.length]);

  // Validate the persisted folder id against the live folders list
  // — folders deleted between sessions snap back to "no folder".
  useEffect(() => {
    if (!folderId) return;
    if (!folders.value.find((f) => f.id === folderId)) setFolderId('');
  }, [folderId, folders.value.length]);

  // Persist every change. JSON-stringifying a Set isn't useful, so
  // we materialize selectedRepos to an array here. knownDefaults records
  // which repos were marked "pre-select" at save time so
  // initRepoSelection can tell a newly-flipped default apart from one the
  // user deliberately unchecked.
  useEffect(() => {
    saveLaunchState({
      cliId, folderId, mode, cwd,
      repos: [...selectedRepos.value],
      knownDefaults: repos.filter((r) => r.defaultSelected).map((r) => r.name),
    });
  }, [cliId, folderId, mode, cwd, selectedRepos.value]);


  const sig = repos.map((r) => r.name + ':' + r.defaultSelected).join('|');
  useStateOnce(sig, () => initRepoSelection(repos, saved));

  const cli = clis.find((c) => c.id === cliId) || clis[0];
  const folder = folders.value.find((f) => f.id === folderId);

  const toggleRepo = (name, on) => {
    const next = new Set(selectedRepos.value);
    if (on) next.add(name); else next.delete(name);
    selectedRepos.value = next;
  };

  const onLaunch = async () => {
    const useCwd = mode === 'cwd' && cwd;
    const chosen = useCwd ? [] : [...selectedRepos.value];
    setBusy(true);
    setResult('');
    resetProgress(chosen, ROOT_ID);
    try {
      const final = await streamNewSession(
        {
          repos: chosen,
          cwd: useCwd ? cwd : undefined,
          cliId: cliId || undefined,
          folderId: folderId || undefined,
        },
        {
          progressRootId: ROOT_ID,
          onMeta: (ev) => {
            if (ev.type === 'workspace') {
              setResult(ev.created ? T.launch.workspaceNewlyCreated(ev.workspace.path) : T.launch.workspaceCreated(ev.workspace.path));
            } else if (ev.type === 'launched') {
              setResult(T.launch.sessionLaunched(ev.launched.id));
            }
          },
        },
      );
      if (final.success && final.launched) {
        setToast(T.launch.launched(final.workspace.name));
        await refreshAll();
        selectSession(final.launched.id);
        selectTab('sessions');
      } else if (!final.success) {
        setResult(`错误 · ${final.error}`);
        setToast(final.error || T.launch.launchFailed, 'error');
      }
    } catch (e) {
      setResult(`错误 · ${e.message}`);
      setToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const close = () => setOpenPicker(null);

  // --- CLI picker config -----------------------------------------------
  const cliItems = clis.map((c) => {
    const Icon = IconForCliType(c.type);
    return {
      id: c.id,
      icon: html`<${Icon} />`,
      label: c.name,
      meta: `${c.command}${c.shell && c.shell !== 'direct' ? ' · ' + c.shell : ''}`,
    };
  });
  const cliCreateFields = [
    { key: 'type', label: '类型', type: 'iconRadio', default: 'other', options: [
      { value: 'claude',  label: T.launch.claudeCli,     icon: html`<${IconClaudeColor} />` },
      { value: 'codex',   label: T.launch.codexCli,      icon: html`<${IconCodexColor} />` },
      { value: 'copilot', label: T.launch.copilotCli, icon: html`<${IconCopilotColor} />` },
      { value: 'other',   label: T.launch.otherCli,            icon: html`<${IconTerminal} />` },
    ],
      onChange: (v, next) => {
        const presets = { claude:  { command: 'claude',  resumeLatestArgs: '--continue',    resumePickerArgs: '--resume', name: T.launch.claudeCode },
                          codex:   { command: 'codex',   resumeLatestArgs: 'resume --last', resumePickerArgs: 'resume',   name: T.launch.openaiCodex },
                          copilot: { command: 'copilot', resumeLatestArgs: '--continue',    resumePickerArgs: '--resume', name: T.launch.githubCopilot },
                          other:   {} }[v] || {};
        const patch = {};
        if (presets.resumeLatestArgs != null) patch.resumeLatestArgs = presets.resumeLatestArgs;
        if (presets.resumePickerArgs != null) patch.resumePickerArgs = presets.resumePickerArgs;
        if (!next.command || !next.command.trim()) patch.command = presets.command || '';
        if (!next.name || !next.name.trim()) patch.name = presets.name || '';
        return patch;
      },
    },
    { key: 'name', label: T.launch.name, placeholder: T.launch.myCli, required: true },
    { key: 'command', label: T.launch.command, mono: true, placeholder: T.launch.commandPlaceholder, required: true },
    { key: 'args', label: T.launch.args, mono: true, placeholder: '' },
    { key: 'resumeLatestArgs', label: T.launch.resumeLatestArgs, mono: true, placeholder: '--continue' },
    { key: 'resumePickerArgs', label: T.launch.resumePickerArgs, mono: true, placeholder: '--resume' },
    { key: 'shell', label: T.launch.shell, type: 'select', default: 'direct', options: [
      { value: 'direct', label: T.launch.direct },
      { value: 'pwsh', label: T.launch.pwsh },
      { value: 'cmd', label: T.launch.cmd },
    ] },
  ];

  // --- Folder picker config --------------------------------------------
  const folderItems = [
    { id: '', label: T.sidebar.unsorted, meta: T.loadSession.noFolder, undraggable: true, icon: html`<${IconFolderOpen} />` },
    ...folders.value.map((f) => ({ id: f.id, label: f.name, icon: html`<${IconFolder} />` })),
  ];
  const folderCreateFields = [
    { key: 'name', label: T.sidebar.folderName, placeholder: '工作 / 个人 / ...', autoFocus: true, required: true },
  ];

  // --- Repo picker config ----------------------------------------------
  const repoItems = repos.map((r) => ({
    id: r.name,
    label: r.name,
    meta: r.url,
  }));
  const repoCreateFields = [
    { key: 'name', label: T.launch.name, placeholder: 'my-repo', autoFocus: true, required: true },
    { key: 'url', label: 'URL', mono: true, placeholder: 'https://github.com/me/foo.git', required: true },
  ];

  const selectedRepoCount = selectedRepos.value.size;

  // Label + title for the unified workdir/repos pill.
  const workdirLabel = (() => {
    if (mode === 'cwd') return cwd ? shortenPath(cwd) : T.launch.pickFolder;
    if (selectedRepoCount === 0) return T.launch.autoWorkspacePill;
    if (selectedRepoCount === 1) return [...selectedRepos.value][0];
    return T.launch.autoRepos(selectedRepoCount);
  })();
  const workdirTitle = mode === 'cwd'
    ? (cwd ? T.launch.workingDirTooltip(cwd) : T.launch.pickExisting)
    : (selectedRepoCount === 0
        ? T.launch.autoTooltip
        : `自动工作空间 · 克隆 ${selectedRepoCount} 个仓库`);

  return html`
    <div class="launch-hero">
      <div class="launch-brand">
        <span class="launch-brand-mark"><${BrandMark} /></span>
      </div>
      <h1 class="launch-tagline">
        ${T.launch.tagline}
      </h1>

      <div class="launch-toolbar">
        <button type="button"
                class=${`pill${openPicker === 'cli' ? ' is-open' : ''}`}
                title=${T.launch.chooseCli}
                onClick=${() => setOpenPicker(openPicker === 'cli' ? null : 'cli')}>
          <span class="pill-icon">${(() => { const I = IconForCliType(cli?.type); return html`<${I} />`; })()}</span>
          <span class="pill-label">${cli ? cli.name : T.launch.chooseCli}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'cli' ? html`
          <${Modal} title=${T.launch.chooseCli} onClose=${close} width=${440}>
            <${PickerPanel} items=${cliItems} selectedId=${cliId}
                            showSearch=${false}
                            onSelect=${(id) => setCliId(id)}
                            onCreate=${async (v) => {
                              try {
                                const id = await createCli(v);
                                setToast(T.launch.createdCli(v.name));
                                return id;
                              } catch (e) { setToast(e.message, 'error'); throw e; }
                            }}
                            createLabel=${T.launch.newCli} createFields=${cliCreateFields}
                            onClose=${close} />
          </${Modal}>` : null}

        <button type="button"
                class=${`pill${openPicker === 'workdir' ? ' is-open' : ''}${(mode === 'cwd' && cwd) ? ' is-set' : ''}`}
                title=${workdirTitle}
                onClick=${() => setOpenPicker(openPicker === 'workdir' ? null : 'workdir')}>
          <span class="pill-icon"><${IconWorkspace} /></span>
          <span class="pill-label">${workdirLabel}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'workdir' ? html`
          <${Modal} title=${T.launch.workingDir} onClose=${close} width=${640}
                    footer=${html`
                      <button type="button" class="action subtle" onClick=${close}>${T.launch.cancel}</button>
                      <button type="button" class="action primary"
                              disabled=${mode === 'cwd' && !cwd}
                              onClick=${close}>
                        ${mode === 'cwd' ? T.launch.useFolder : T.launch.done}
                      </button>`}>
            <div class="workdir-modal">
              <div class="workdir-mode-grid">
                <button type="button"
                        class=${`workdir-mode-opt${mode === 'auto' ? ' is-active' : ''}`}
                        onClick=${() => setMode('auto')}>
                  <span class="workdir-mode-icon"><${IconSparkle} /></span>
                  <span class="workdir-mode-name">${T.launch.autoWorkspace}</span>
                  <span class="workdir-mode-sub">${T.launch.autoWorkspaceDesc}</span>
                </button>
                <button type="button"
                        class=${`workdir-mode-opt${mode === 'cwd' ? ' is-active' : ''}`}
                        onClick=${() => setMode('cwd')}>
                  <span class="workdir-mode-icon"><${IconFolderOpen} /></span>
                  <span class="workdir-mode-name">${T.launch.existingFolder}</span>
                  <span class="workdir-mode-sub">${T.launch.existingFolderDesc}</span>
                </button>
              </div>
              <div class="workdir-detail">
                ${mode === 'auto' ? html`
                  <${PickerPanel} items=${repoItems} multi
                                  showSearch=${false}
                                  selectedIds=${selectedRepos.value}
                                  onToggle=${toggleRepo}
                                  title=${T.launch.reposToClone}
                                  emptyHint=${T.launch.noReposConfigured}
                                  onCreate=${async (v) => {
                                    try {
                                      const name = await createRepo(v);
                                      setToast(T.launch.addedRepo(name));
                                      return name;
                                    } catch (e) { setToast(e.message, 'error'); throw e; }
                                  }}
                                  createLabel=${T.launch.newRepo} createFields=${repoCreateFields}
                                  onClose=${close} />
                ` : html`
                  <${DirectoryPicker} initialPath=${cwd || ''}
                                      onPick=${(p) => { setCwd(p); }} />
                `}
              </div>
            </div>
          </${Modal}>` : null}

        <button type="button"
                class=${`pill${openPicker === 'folder' ? ' is-open' : ''}`}
                title=${T.launch.chooseFolder}
                onClick=${() => setOpenPicker(openPicker === 'folder' ? null : 'folder')}>
          <span class="pill-icon"><${IconFolder} /></span>
          <span class="pill-label">${folder ? folder.name : T.sidebar.unsorted}</span>
          <span class="pill-chev"><${IconChevronDown} /></span>
        </button>
        ${openPicker === 'folder' ? html`
          <${Modal} title=${T.launch.chooseFolder} onClose=${close} width=${400}>
            <${PickerPanel} items=${folderItems} selectedId=${folderId}
                            showSearch=${false}
                            onSelect=${(id) => setFolderId(id)}
                            onCreate=${async (v) => {
                              try {
                                const f = await createFolder(v.name);
                                setToast(T.launch.createdFolder(v.name));
                                return f?.id;
                              } catch (e) { setToast(e.message, 'error'); throw e; }
                            }}
                            createLabel=${T.launch.newFolder} createFields=${folderCreateFields}
                            onClose=${close} />
          </${Modal}>` : null}
      </div>

      <button class="action primary launch-cta"
              disabled=${busy || !cliId || (mode === 'cwd' && !cwd)}
              onClick=${onLaunch}>
        ${busy ? T.launch.launching : html`${T.launch.launch} <span class="launch-cta-plane" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2 11 13"/>
            <path d="M22 2 15 22l-4-9-9-4Z"/>
          </svg>
        </span>`}
      </button>

      <button type="button" class="launch-load-link"
              onClick=${() => setShowLoad(true)}>
        <${IconFolderOpen} /> ${T.launch.loadExisting}
      </button>
      ${showLoad ? html`
        <${LoadSessionModal} defaultFolderId=${folderId}
                             onClose=${() => setShowLoad(false)} />` : null}

      <${ProgressList} rootId=${ROOT_ID} />
      ${result ? html`<div class="launch-status mono">${result}</div>` : null}
    </div>`;
}

let lastKey = null;
function useStateOnce(key, init) {
  if (key !== lastKey) {
    lastKey = key;
    init();
  }
}

// Truncate a long path so it fits the pill nicely.
//   C:\Users\admin\proj\foo\bar  →  …\foo\bar
function shortenPath(p) {
  if (!p) return '';
  if (p.length <= 28) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + sep + parts.slice(-2).join(sep);
}

export function LaunchPage() {
  return html`
    <${PageTitleBar} title=${T.launch.title} />
    <${LaunchHero} />`;
}
