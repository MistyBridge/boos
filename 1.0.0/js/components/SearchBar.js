// SearchBar — sidebar inline filter for the session tree. Debounced
// input drives the `sessionFilter` signal; SessionTree reads it to
// filter sessions by title, workspace, or CLI type/name.
//
// The input uses local state for immediate typing feedback — keystrokes
// update the displayed value instantly while the signal is debounced
// by 200ms. This avoids the controlled-input reversion that happens
// when the signal hasn't caught up yet.

import { html } from '../html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { sessionFilter, sessions, config } from '../state.js';
import { IconSearch, IconClose } from '../icons.js';

const DEBOUNCE_MS = 200;

export function SearchBar() {
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  // Local display value — updates immediately on every keystroke.
  const [inputValue, setInputValue] = useState(sessionFilter.value);
  const filterText = sessionFilter.value;

  // Sync local value when the signal is cleared externally (e.g. another
  // component resets sessionFilter to '').
  useEffect(() => {
    if (sessionFilter.value === '' && inputValue !== '') {
      setInputValue('');
    }
  }, [sessionFilter.value]);

  // Cleanup the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const totalSessions = sessions.value.length;

  const onInput = (ev) => {
    const raw = ev.target.value;
    setInputValue(raw);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sessionFilter.value = raw;
    }, DEBOUNCE_MS);
  };

  const onClear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setInputValue('');
    sessionFilter.value = '';
    if (inputRef.current) inputRef.current.focus();
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClear();
    }
  };

  const hasFilter = !!inputValue;

  return html`
    <div class="sidebar-search">
      <span class="sidebar-search-icon"><${IconSearch} size=${13} /></span>
      <input class="sidebar-search-input"
             ref=${inputRef}
             type="text"
             placeholder=${hasFilter
               ? `筛选 ${totalSessions} 个会话…`
               : `搜索 ${totalSessions} 个会话…`}
             value=${inputValue}
             onInput=${onInput}
             onKeyDown=${onKeyDown}
             autocomplete="off"
             spellcheck=${false} />
      ${hasFilter ? html`
        <button class="sidebar-search-clear" type="button"
                title="清除搜索"
                onClick=${onClear}>
          <${IconClose} size=${12} stroke=${2} />
        </button>
      ` : null}
    </div>`;
}

// Match a session against a filter string. Case-insensitive substring
// match on title, workspace path, CLI id, and CLI display name.
export function matchesFilter(s, filter) {
  if (!filter) return true;
  const q = filter.toLowerCase().trim();
  if (!q) return true;
  const title = (s.title || s.workspace || '').toLowerCase();
  const cwd = (s.cwd || '').toLowerCase();
  const cliId = (s.cliId || '').toLowerCase();
  if (title.includes(q)) return true;
  if (cwd.includes(q)) return true;
  if (cliId.includes(q)) return true;
  // Also check the CLI's display name (e.g. "Claude", "Codex", "Copilot").
  const clis = config.value?.clis || [];
  const cli = clis.find((c) => c.id === s.cliId);
  if (cli) {
    const cliName = (cli.name || '').toLowerCase();
    if (cliName.includes(q)) return true;
  }
  return false;
}
