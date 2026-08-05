// Pure formatters · no DOM access.
import { T, fmtAgoZh, fmtTimeZh, displayTitleZh } from './i18n.js';

export function fmtTime(ms) {
  if (!ms) return T.util.dash;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function fmtAgo(ms) {
  if (!ms) return T.util.dash;
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return T.util.sAgo(sec);
  if (sec < 3600) return T.util.mAgo(Math.floor(sec / 60));
  if (sec < 86400) return T.util.hAgo(Math.floor(sec / 3600));
  return T.util.dAgo(Math.floor(sec / 86400));
}

// label override beats claude's ai-title; both empty → "(no title)"
export function displayTitle(label, fallback) {
  return label || fallback || T.util.noTitle;
}

export function nowClock() {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

// Shell-style argv tokenizer / formatter used by the CLI editor's
// args / resumeLatestArgs / resumePickerArgs fields. Modeled on POSIX sh
// word splitting + bash quoting (the rules every dev already has in
// muscle memory) — not a full shell parser. Handles:
//   bare token        -Model         → "-Model"
//   double-quoted     "a b c"        → "a b c"
//                                    \\ and \" are escapes inside ""; any
//                                    other backslash is kept literal, so
//                                    "C:\Users\foo" survives intact (bash
//                                    rule, matters for Windows paths).
//   single-quoted     'a b c'        → "a b c"   literal, no escapes
//   mixed             -Foo "x y" 'z' → ["-Foo","x y","z"]
// Anything malformed (unclosed quote, etc.) falls through to a bare
// best-effort match so the user can keep typing without the field
// nuking their input mid-type.
export function parseArgs(input) {
  const s = String(input || '');
  const out = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined)      out.push(m[1]);
    else if (m[2] !== undefined) out.push(m[2].replace(/\\([\\"])/g, '$1'));
    else                         out.push(m[3]);
  }
  return out;
}

// Inverse of parseArgs — used when re-populating the textarea from a
// stored array. Bare-emit when the token has no shell-significant chars;
// otherwise double-quote with \" and \\ escapes. Round-trip is stable
// (parse(format(arr)) === arr) for any string array.
export function formatArgs(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((a) => {
    const s = String(a ?? '');
    if (s === '') return '""';
    if (/[\s"'\\`$]/.test(s)) {
      return '"' + s.replace(/([\\"])/g, '\\$1') + '"';
    }
    return s;
  }).join(' ');
}
