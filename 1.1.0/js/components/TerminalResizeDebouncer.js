// Sprint 18 P1: simplified resize debouncer.
// P0 rAF output batching + independent Canvas + CSS containment eliminate
// the resize cascade that the old threshold/debounce logic was designed for.
// All resizes now go through a single rAF coalesce per frame — no idle
// callbacks, no threshold gating, no separate X/Y paths.

export class TerminalResizeDebouncer {
  constructor({ isVisible, getXterm, resizeBoth, resizeX, resizeY }) {
    this.isVisible = isVisible;
    this.getXterm = getXterm;
    this.resizeBoth = resizeBoth;
    this.resizeX = resizeX;
    this.resizeY = resizeY;
    this.latestCols = 0;
    this.latestRows = 0;
    this.pending = false;
    this.disposed = false;
  }

  resize(cols, rows, immediate = false) {
    if (this.disposed) return;
    this.latestCols = cols;
    this.latestRows = rows;

    if (immediate) {
      this.pending = false;
      this.resizeBoth(cols, rows);
      return;
    }

    // Coalesce into a single rAF — one resize per frame max.
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        if (!this.disposed) {
          this.resizeBoth(this.latestCols, this.latestRows);
        }
      });
    }
  }

  flush() {
    if (this.disposed) return;
    if (!this.pending) return;
    this.pending = false;
    this.resizeBoth(this.latestCols, this.latestRows);
  }

  dispose() {
    this.disposed = true;
    this.pending = false;
  }
}
