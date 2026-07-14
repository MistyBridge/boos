import { html } from '../html.js';
import { signal } from '@preact/signals';
import {
  activeTab, sidebarCollapsed, sidebarForcedCollapsed, isMobile, configDirty, capabilities, config,
  sessions, deletedSessions, folders, sessionsByFolder, foldersCollapsed, activeSessionId,
  selectTab, selectSession, toggleSidebar, toggleFolder, setSidebarWidth,
  closeOpenSessionTab, clearActiveSession, openWorkspaceForFolder, workspaceFolderId,
  installPrompt, isInstalledPwa, sessionFilter,
} from '../state.js';
import { createFolder, renameFolder, deleteFolder, reorderFolders, setSessionFolder, reorderSessions, deleteSession, restoreSession, resumeSession, setSessionTitle, refreshAll, importSessionById } from '../api.js';
import { isRemoteAccess } from '../backend.js';
import { boosPrompt, boosConfirm } from '../dialog.js';
import { setToast } from '../toast.js';
import { fmtAgo } from '../util.js';
import { clockTick } from '../state.js';
import { T } from '../i18n.js';
import { useDragSort } from './useDragSort.js';
import { streamNewSession } from '../streaming.js';
import { buildLaunchBodyFromState } from '../launchState.js';
import {
  IconLaunch, IconConfigure, IconRemote, IconWorkspace,
  IconSidebarToggle, IconPencil, IconClose, IconFolder, IconFolderOpen, IconPlus,
  IconTrash, IconRestore, IconTerminal, BrandMark, IconCanvas, IconDecisions,
} from '../icons.js';
import { SearchBar, matchesFilter } from './SearchBar.js';

// Module-level drag state for session → folder moves. Lives outside the
// useDragSort hook (which handles same-list folder reorder) so the two
// don't interfere — session drags and folder drags use disjoint state.
// Folder key: folder.id for real folders, the literal string 'unsorted'
// for the implicit top-level Unsorted bucket.
const draggingSessionId = signal(null);
const dragOverFolderKey = signal(null);
const launchingFolderKey = signal(null);
const folderKey = (folder) => folder ? folder.id : 'unsorted';

function NavItem({ tab, icon, label, dirty, onClick }) {
  const selected = activeTab.value === tab;
  return html`
    <button class=${`nav-item${dirty ? ' has-changes' : ''}${selected ? ' is-active' : ''}`}
            role="tab" aria-selected=${selected ? 'true' : 'false'}
            onClick=${() => { if (onClick) onClick(); selectTab(tab); }}>
      <span class="nav-icon">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>`;
}

// Module-level: the SessionRow currently being hovered as a reorder
// drop target. Set on dragOver, cleared on dragLeave/end. Drives the
// "above this row" insert-line indicator.
const reorderOverSessionId = signal(null);

// One row in the session tree. Click → open in main pane. Drag-to-folder
// is handled by FolderGroup's drop zone; same-folder reorder is handled
// here: the row is a drop target when an in-folder sibling is dragged.
function SessionRow({ s, folderId, siblingIds }) {
  clockTick.value; // subscribe for fmtAgo refresh
  const isActive = activeSessionId.value === s.id;
  const running = s.status === 'running';
  const title = s.title || s.workspace || s.id.slice(0, 12);

  const onClick = async (ev) => {
    ev.preventDefault();
    selectSession(s.id);
    // Auto-resume on click if the session stopped on its own. Explicitly
    // stopped sessions stay stopped until the user presses Resume.
    if (s.status !== 'running' && !s.manualStopped) {
      try { await resumeSession(s.id); }
      catch (e) { setToast(e.message, 'error'); }
    }
  };

  const onRenameClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const next = await boosPrompt(T.sidebar.newTitle, title, { title: T.sidebar.renameSession, okLabel: T.sidebar.save });
    if (next === null) return;
    try { await setSessionTitle(s.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDeleteClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ok = await boosConfirm(T.sidebar.deleteSessionConfirm(title), {
      title: T.sidebar.deleteSession, okLabel: T.sidebar.delete, danger: true });
    if (!ok) return;
    try {
      await deleteSession(s.id);
      closeOpenSessionTab(s.id);
      if (activeSessionId.value === s.id) clearActiveSession();
    } catch (e) { setToast(e.message, 'error'); }
  };

  const onDragStart = (ev) => {
    draggingSessionId.value = s.id;
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', s.id); } catch {}
  };
  const onDragEnd = () => {
    draggingSessionId.value = null;
    dragOverFolderKey.value = null;
    reorderOverSessionId.value = null;
  };

  // Drop on a session row → place the dragged session at THIS row's
  // position. Same folder = pure reorder. Different folder = move +
  // position in one shot (reorderSessions sets both folderId and
  // order in one backend call). stopPropagation so .tree-folder
  // doesn't also fire its "drop into folder" handler — landing on a
  // row is the more specific intent.
  const draggedId = draggingSessionId.value;
  const acceptDrop = !!draggedId && draggedId !== s.id;
  const showInsertLine = acceptDrop && reorderOverSessionId.value === s.id;

  const onRowDragOver = (ev) => {
    if (!acceptDrop) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'move';
    if (reorderOverSessionId.value !== s.id) reorderOverSessionId.value = s.id;
    // Also clear the parent folder's drop-target highlight — we're
    // overriding to "drop on this row" semantics.
    if (dragOverFolderKey.value) dragOverFolderKey.value = null;
  };
  const onRowDragLeave = (ev) => {
    if (!acceptDrop) return;
    const rt = ev.relatedTarget;
    if (rt && ev.currentTarget.contains(rt)) return;
    if (reorderOverSessionId.value === s.id) reorderOverSessionId.value = null;
  };
  const onRowDrop = (ev) => {
    if (!acceptDrop) return;
    ev.preventDefault();
    ev.stopPropagation();
    const draggedSid = draggingSessionId.value;
    draggingSessionId.value = null;
    reorderOverSessionId.value = null;
    dragOverFolderKey.value = null;
    if (!draggedSid || !siblingIds) return;
    // Build the new sibling sequence: remove dragged (in case it was
    // already in this folder) then insert at this row's slot.
    const next = siblingIds.filter((id) => id !== draggedSid);
    const targetIdx = next.indexOf(s.id);
    if (targetIdx < 0) return;
    next.splice(targetIdx, 0, draggedSid);
    reorderSessions(folderId || null, next)
      .catch((e) => setToast(e.message, 'error'));
  };

  // Skip the HTML5 drag affordance on touch devices — `draggable=true`
  // makes mobile browsers interpret the first tap as a drag-start
  // gesture, swallowing the click event entirely. The user then needs
  // a second tap to navigate. Touch users don't reorder sessions by
  // drag anyway; we'd add a dedicated "move to folder" affordance if
  // anyone asked.
  const touchDevice = isMobile.value || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  return html`
    <div class=${`tree-session${isActive ? ' is-active' : ''}${running ? ' is-running' : ' is-stopped'}${running && s.activity === 'working' ? ' is-working' : ''}${showInsertLine ? ' is-reorder-target' : ''}`}
         draggable=${!touchDevice}
         onDragStart=${onDragStart}
         onDragEnd=${onDragEnd}
         onDragOver=${onRowDragOver}
         onDragLeave=${onRowDragLeave}
         onDrop=${onRowDrop}
         onClick=${onClick}
         title=${`${title}\n${s.cwd}\n${running ? (s.activity === 'working' ? 'working' : 'idle') : 'stopped'} · ${s.cliId}`}>
      <span class=${`tree-dot ${running ? 'is-running' : 'is-stopped'}${running && s.activity === 'working' ? ' is-working' : ''}`}></span>
      <span class="tree-label">${title}</span>
      <span class="tree-session-actions">
        <button class="tree-session-action" title=${T.sidebar.rename} onClick=${onRenameClick}><${IconPencil} /></button>
        <button class="tree-session-action" title=${T.sidebar.delete} onClick=${onDeleteClick}><${IconClose} /></button>
      </span>
      <span class="tree-meta">${fmtAgo(s.lastActiveAt)}</span>
    </div>`;
}

function DeletedSessionRow({ s }) {
  clockTick.value; // subscribe for fmtAgo refresh
  const title = s.title || s.workspace || s.id.slice(0, 12);
  const onRestoreClick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const restored = await restoreSession(s.id);
      setToast(T.sidebar.sessionRestored);
      if (restored?.id) selectSession(restored.id);
    } catch (e) { setToast(e.message, 'error'); }
  };
  return html`
    <div class="tree-session tree-session-deleted"
         title=${`${title}\n${s.cwd}\ndeleted ${fmtAgo(s.deletedAt)} · ${s.cliId}`}>
      <span class="tree-deleted-icon"><${IconTerminal} /></span>
      <span class="tree-label">${title}</span>
      <span class="tree-session-actions">
        <button class="tree-session-action" title="恢复" onClick=${onRestoreClick}><${IconRestore} /></button>
      </span>
      <span class="tree-meta">${fmtAgo(s.deletedAt)}</span>
    </div>`;
}

function DeletedSessionsGroup() {
  const list = deletedSessions.value;
  const key = 'deleted';
  const collapsed = !!foldersCollapsed.value[key];
  return html`
    <div class="tree-folder tree-folder-deleted">
      <button class=${`tree-folder-head${collapsed ? '' : ' is-open'}`} onClick=${() => toggleFolder(key)}>
        <span class="tree-folder-icon"><${IconTrash} /></span>
        <span class="tree-folder-name">${T.sidebar.deleted}</span>
        ${list.length ? html`<span class="tree-folder-count">${list.length}</span>` : null}
      </button>
      ${!collapsed ? html`
        <div class="tree-folder-body">
          ${list.length === 0
            ? html`<div class="tree-empty">${T.sidebar.noDeletedSessions}</div>`
            : list.map((s) => html`<${DeletedSessionRow} key=${s.id} s=${s} />`)}
        </div>
      ` : null}
    </div>`;
}

function FolderGroup({ folder, sessionList, dndHandle, dndRow }) {
  // folder is now always set — backend materializes a synthetic
  // {id:'unsorted', name:'Unsorted', builtin:true} entry alongside the
  // user folders. The bucket can be drag-reordered like any other but
  // Rename / Delete are hidden, and drops set folderId=null so existing
  // sessions don't need a data migration.
  const isUnsorted = folder?.id === 'unsorted' || folder?.builtin;
  const key = folder ? folder.id : 'unsorted';
  const collapsed = !!foldersCollapsed.value[key];
  const name = folder ? folder.name : T.sidebar.unsorted;
  const onToggle = () => toggleFolder(folder ? folder.id : null);

  const onRename = async (ev) => {
    ev.stopPropagation();
    if (!folder || isUnsorted) return;
    const next = await boosPrompt(T.sidebar.renameFolder, folder.name, { title: folder.name, okLabel: T.sidebar.save });
    if (next === null || !next.trim()) return;
    try { await renameFolder(folder.id, next.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const onDelete = async (ev) => {
    ev.stopPropagation();
    if (!folder || isUnsorted) return;
    const ok = await boosConfirm(T.sidebar.deleteFolderConfirm(folder.name), {
      title: T.sidebar.deleteFolder, okLabel: T.sidebar.delete, danger: true });
    if (!ok) return;
    try { await deleteFolder(folder.id); }
    catch (e) { setToast(e.message, 'error'); }
  };

  // Session-into-folder drop target. We don't go through useDragSort
  // because that one is wired for folder-reorder. Folder reorder's
  // handlers (in dndRow) short-circuit when no folder is being dragged,
  // and our handlers below short-circuit when no session is being
  // dragged — so composing both is safe.
  // When the dragged session lands on the Unsorted bucket, we persist
  // it with folderId=null (matches the existing data model — sessions
  // with no folder are null, not 'unsorted'). Same for the sameFolder
  // guard below.
  const dropFolderId = isUnsorted ? null : (folder ? folder.id : null);
  const isLaunching = launchingFolderKey.value === key;
  const draggedSession = draggingSessionId.value
    ? sessions.value.find((s) => s.id === draggingSessionId.value)
    : null;
  const sameFolder = draggedSession
    && (draggedSession.folderId || null) === dropFolderId;
  const isOver = !sameFolder && dragOverFolderKey.value === key;

  const onSessionDragOver = (ev) => {
    if (!draggingSessionId.value || sameFolder) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    if (dragOverFolderKey.value !== key) dragOverFolderKey.value = key;
  };
  const onSessionDragLeave = (ev) => {
    if (!draggingSessionId.value) return;
    const rt = ev.relatedTarget;
    if (rt && ev.currentTarget.contains(rt)) return;
    if (dragOverFolderKey.value === key) dragOverFolderKey.value = null;
  };
  const onSessionDrop = (ev) => {
    const sid = draggingSessionId.value;
    draggingSessionId.value = null;
    dragOverFolderKey.value = null;
    if (!sid || sameFolder) return;
    ev.preventDefault();
    ev.stopPropagation();
    setSessionFolder(sid, dropFolderId)
      .then(() => setToast(T.sidebar.movedTo(name)))
      .catch((e) => setToast(e.message, 'error'));
  };

  const onLaunchInFolder = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (launchingFolderKey.value) return;

    const built = buildLaunchBodyFromState(config.value || {}, { folderId: dropFolderId });
    if (built.error) {
      setToast(built.error, 'error');
      selectTab('launch');
      return;
    }

    launchingFolderKey.value = key;
    setToast(`正在 ${name} 中启动...`);
    try {
      const final = await streamNewSession(built.body, {
        progressRootId: 'sidebarQuickLaunchProgress',
        onMeta: (event) => {
          if (event.type === 'workspace') {
            setToast(T.sidebar.workspaceCreated(event.workspace.name));
          }
        },
      });
      if (final.success && final.launched?.id) {
        await refreshAll();
        setToast(T.sidebar.launchedIn(name));
        selectSession(final.launched.id);
      } else if (final.success && final.session?.id) {
        await refreshAll();
        setToast(T.sidebar.sessionReadyIn(name));
        selectSession(final.session.id);
      } else {
        setToast(final.error || T.sidebar.launchFailed, 'error');
      }
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      if (launchingFolderKey.value === key) launchingFolderKey.value = null;
    }
  };

  // Spread folder-reorder row handlers first, then compose our
  // session-drop handlers on top so both fire.
  const { onDragOver: rowOver, onDragLeave: rowLeave, onDrop: rowDrop, ...rowAttrs } = dndRow || {};
  const composedOver = (ev) => { onSessionDragOver(ev); rowOver?.(ev); };
  const composedLeave = (ev) => { onSessionDragLeave(ev); rowLeave?.(ev); };
  const composedDrop = (ev) => { onSessionDrop(ev); rowDrop?.(ev); };

  return html`
    <div class=${`tree-folder${isOver ? ' is-session-drop-target' : ''}`}
         ...${rowAttrs}
         onDragOver=${composedOver}
         onDragLeave=${composedLeave}
         onDrop=${composedDrop}>
      <button class=${`tree-folder-head${collapsed ? '' : ' is-open'}`} onClick=${onToggle}
              ...${dndHandle || {}}>
        <span class="tree-folder-icon">
          ${collapsed ? html`<${IconFolder} />` : html`<${IconFolderOpen} />`}
        </span>
        <span class="tree-folder-name">${name}</span>
        <span class="tree-folder-actions">
          <button class="tree-folder-action"
                  title=${isLaunching ? T.sidebar.launching : T.sidebar.launchIn(name)}
                  disabled=${isLaunching}
                  onClick=${onLaunchInFolder}>
            <${IconPlus} />
          </button>
          ${sessionList.length > 0 ? html`
            <button class="tree-folder-action"
                    title=${'在画布中打开 ' + name}
                    onClick=${(ev) => { ev.preventDefault(); ev.stopPropagation(); openWorkspaceForFolder(key, name); }}>
              <${IconCanvas} />
            </button>
          ` : null}
          ${folder && !isUnsorted ? html`
            <button class="tree-folder-action" title=${T.sidebar.rename} onClick=${onRename}><${IconPencil} /></button>
            <button class="tree-folder-action" title=${T.sidebar.delete} onClick=${onDelete}><${IconClose} /></button>
          ` : null}
        </span>
      </button>
      ${!collapsed ? html`
        <div class="tree-folder-body">
          ${sessionList.length === 0
            ? html`<div class="tree-empty">${T.sidebar.noSessions}</div>`
            : (() => {
                // siblingIds captured once per render so each row sees a
                // consistent snapshot for splice math.
                const siblingIds = sessionList.map((x) => x.id);
                return sessionList.map((s) => html`
                  <${SessionRow} key=${s.id} s=${s}
                                 folderId=${dropFolderId}
                                 siblingIds=${siblingIds} />`);
              })()}
        </div>
      ` : null}
    </div>`;
}

function ImportById() {
  const importing = signal(false);
  const inputValue = signal('');

  const onSubmit = async (ev) => {
    ev.preventDefault();
    const id = inputValue.value.trim();
    if (!id) return;
    importing.value = true;
    try {
      const r = await importSessionById(id);
      if (r.alreadyAdopted) {
        setToast(T.sidebar.importAlready(r.session.title || r.session.id));
        selectSession(r.session.id);
      } else {
        setToast(T.sidebar.imported(r.summary || r.cwd || 'session ' + id.slice(0, 12)));
        if (r.session?.id) selectSession(r.session.id);
      }
      inputValue.value = '';
    } catch (e) {
      setToast(e.message, 'error');
    } finally {
      importing.value = false;
    }
  };

  return html`
    <form class="import-by-id" onSubmit=${onSubmit}>
      <input type="text"
             class="import-by-id-input"
             placeholder=${T.sidebar.importPlaceholder}
             value=${inputValue.value}
             onInput=${(ev) => { inputValue.value = ev.target.value; }}
             disabled=${importing.value} />
      <button type="submit"
              class="action subtle import-by-id-btn"
              disabled=${importing.value || !inputValue.value.trim()}>
        ${T.sidebar.importBtn}
      </button>
    </form>`;
}

function SessionTree() {
  const grouped = sessionsByFolder.value;
  const orderedFolders = folders.value;
  const dnd = useDragSort(
    orderedFolders.map((f) => f.id),
    async (nextIds) => {
      try { await reorderFolders(nextIds); }
      catch (e) { setToast(e.message, 'error'); }
    },
  );

  const onNewFolder = async () => {
    const name = await boosPrompt(T.sidebar.folderName, '', { title: T.sidebar.newFolder, okLabel: T.sidebar.create });
    if (!name || !name.trim()) return;
    try { await createFolder(name.trim()); }
    catch (e) { setToast(e.message, 'error'); }
  };

  const runningCount = sessions.value.filter((s) => s.status === 'running').length;
  const filter = sessionFilter.value;

  return html`
    <${SearchBar} />
    <div class="tree">
      <div class="tree-head">
        <span class="tree-head-label">${T.sidebar.sessions}</span>
        ${runningCount > 0 ? html`<span class="tree-head-badge">${runningCount}</span>` : null}
        <button class="tree-head-action" title=${T.sidebar.newFolder} onClick=${onNewFolder}>
          <${IconPlus} />
        </button>
      </div>
      ${orderedFolders.map((f) => {
        const raw = grouped.get(f.id) || [];
        const filtered = filter ? raw.filter((s) => matchesFilter(s, filter)) : raw;
        return html`
        <${FolderGroup} key=${f.id} folder=${f}
                        sessionList=${filtered}
                        dndHandle=${dnd.handleProps(f.id)}
                        dndRow=${dnd.rowProps(f.id)} />`;
      })}
      <${DeletedSessionsGroup} />
      <${ImportById} />
      <div class="tree-sessions-txt-hint">
        ID 存储在 <code>sessions.txt</code>
      </div>
    </div>`;
}

export function Sidebar() {
  // On phones the sidebar is rendered inside a full-screen drawer
  // (App applies .is-mobile + .drawer-open classes). It should always
  // appear in EXPANDED form there — full labels + sessions tree.
  // Desktop/tablet keeps the original collapse behaviour.
  const mobile = isMobile.value;
  const collapsed = !mobile && (sidebarCollapsed.value || sidebarForcedCollapsed.value);
  const forced = !mobile && sidebarForcedCollapsed.value;

  const onResizeStart = (ev) => {
    if (collapsed) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-resizing-sidebar');
    const move = (e) => setSidebarWidth(e.clientX);
    const up = () => {
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      document.body.classList.remove('is-resizing-sidebar');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return html`
    <aside class="sidebar" data-collapsed=${collapsed ? 'true' : 'false'}>
      <div class="sidebar-top">
        <button class="sidebar-brand sidebar-brand-button"
                role="tab" aria-selected=${activeTab.value === 'about' ? 'true' : 'false'}
                title=${T.sidebar.about}
                onClick=${() => selectTab('about')}>
          <span class="brand-mark"><${BrandMark} /></span>
          <span class="brand-name">${T.appName}</span>
        </button>
      </div>

      <nav class="sidebar-nav compact" role="tablist" aria-label="Sections">
        <${NavItem} tab="launch"    icon=${html`<${IconLaunch} />`}    label=${T.sidebar.newSession} />
        <${NavItem} tab="workspace" icon=${html`<${IconWorkspace} />`} label="工作区"
                   onClick=${() => { workspaceFolderId.value = null; }} />
        <${NavItem} tab="decisions" icon=${html`<${IconDecisions} />`} label=${T.decisions.title} />
        ${!isRemoteAccess() ? html`
          <${NavItem} tab="remote"  icon=${html`<${IconRemote} />`}    label=${T.remote.title} />
        ` : null}
        <${NavItem} tab="configure" icon=${html`<${IconConfigure} />`} label=${T.sidebar.settings} dirty=${configDirty.value} />
      </nav>

      ${!collapsed ? html`<${SessionTree} />` : null}

      <div class="sidebar-foot">
        ${!forced ? html`
          <button class="util-item collapse-toggle" aria-label=${collapsed ? T.sidebar.expandSidebar : T.sidebar.collapseSidebar}
                  title=${collapsed ? T.sidebar.expandSidebar : T.sidebar.collapseSidebar}
                  onClick=${toggleSidebar}>
            <span class="nav-icon"><${IconSidebarToggle} /></span>
          </button>
        ` : null}
        ${installPrompt.value && !isInstalledPwa.value ? html`
          <button class="util-item install-button"
                  title="安装 BOOS 到桌面"
                  onClick=${async () => {
                    try {
                      const ev = installPrompt.value;
                      ev.prompt();
                      const { outcome } = await ev.userChoice;
                      installPrompt.value = null;
                      if (outcome === 'accepted') isInstalledPwa.value = true;
                    } catch {}
                  }}>
            <span class="nav-icon install-icon">⬇</span>
            <span class="nav-label">安装应用</span>
          </button>
        ` : null}
      </div>

      ${!collapsed ? html`
        <div class="sidebar-resize-handle" role="separator" aria-orientation="vertical"
             aria-label=${T.sidebar.resizeSidebar}
             title=${T.sidebar.dragToResize}
             onPointerDown=${onResizeStart}
             onDblClick=${() => setSidebarWidth(232)}></div>
      ` : null}
    </aside>`;
}
