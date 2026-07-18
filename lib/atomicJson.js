'use strict';

// Atomic JSON-file writes + per-file serialization.
//
// The naive pattern (`fs.writeFile(path, JSON.stringify(...))`) has two
// bugs under concurrent callers:
//
//   1. fs.writeFile overwrites byte-by-byte but does NOT pre-truncate.
//      If writer A's serialization is longer than writer B's, and B
//      finishes second, B writes only its own bytes — A's trailing
//      bytes stay on disk. Result: `]  }\n]` style JSON corruption.
//
//   2. Even with atomic writes, concurrent `load → mutate → save`
//      sequences lose updates: A and B both read state v0, both write
//      their own v1 — the later writer wins, the earlier one's edits
//      vanish.
//
// Fixes:
//
//   - atomicWriteJson: write to a sibling tmp file with fsync, back up
//     the existing file, then rename onto the target. rename is atomic
//     on the same volume (NTFS / POSIX), so readers see either the old
//     complete file or the new complete file. No truncation problem.
//
//   - withFileLock: serialize all mutators of a given file through a
//     per-path promise chain with configurable timeout. Callers wrap
//     their whole load/mutate/save in withFileLock(path, fn) and are
//     guaranteed exclusivity.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

/**
 * Retry fn with exponential backoff for transient EPERM/EACCES/EBUSY errors
 * that happen when multiple processes contend for the same file.
 */
async function _retryOnPerm(fn, maxRetries = 4) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < maxRetries && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY')) {
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 50 + Math.random() * 30));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Cross-process file lock — uses a sibling .lock file with exclusive-create
 * to ensure only one process mutates the target file at a time.
 *
 * The lock file is NOT a regular open file handle but a sentinel file.
 * Windows has poor support for POSIX-style fcntl/flock, but O_CREAT|O_EXCL
 * (equivalent to open(path, 'wx')) IS atomic across processes on all
 * platforms including Windows. We use it as a simple mutual-exclusion
 * primitive.
 *
 * The lock is best-effort: if the lock file lingers from a crashed process
 * (e.g. SIGKILL), staleLockTimeoutMs allows automatic recovery.
 */
async function _acquireCrossProcessLock(lockPath, staleLockTimeoutMs = 5000) {
  // Try to create the lock file atomically — if it already exists,
  // check if the holder is stale.
  for (;;) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return; // Lock acquired.
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // Lock file exists — check if it's stale.
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > staleLockTimeoutMs) {
        // Stale — the holder may have crashed. Force-reclaim the lock.
        try { await fs.unlink(lockPath); } catch {}
        continue; // Retry acquisition.
      }
    } catch {}

    // Not stale — wait and retry.
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
  }
}

async function _releaseCrossProcessLock(lockPath) {
  try { await fs.unlink(lockPath); } catch {}
}

/**
 * Atomically write JSON to `filePath`.
 *
 * 1. Serialize data → JSON string.
 * 2. Open tmp file, write, fsync, close — guarantees data is on disk
 *    before the rename, preventing empty/corrupt files after a crash.
 * 3. Copy existing file → .bak before the rename so there's always a
 *    recoverable previous version.
 * 4. rename(tmp, target) — atomic on NTFS/ext4/xfs.
 * 5. Clean up tmp file on any failure.
 *
 * @param {string} filePath  absolute path to the target JSON file
 * @param {any}    data      serializable value
 * @returns {Promise<void>}
 */
async function atomicWriteJson(filePath, data) {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );
  const lockPath = `${filePath}.lock`;

  try {
    // 0. Acquire cross-process lock so two instances don't stomp each other.
    //    On Windows this prevents EPERM on rename when another process holds
    //    a read handle on the target.
    await _acquireCrossProcessLock(lockPath);

    // 1. Serialize
    const json = JSON.stringify(data, null, 2);

    // 2. Write tmp file + fsync for durability.
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.write(json, 0, 'utf-8');
      await fh.sync();    // fsync / FlushFileBuffers — data is now durable
    } finally {
      await fh.close();
    }

    // 3. Backup: keep the last-known-good copy as <file>.bak.
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    // 4. Atomic rename onto the real path, with retry for transient
    //    Windows permission errors.
    await _retryOnPerm(() => fs.rename(tmp, filePath));
  } catch (e) {
    // Best-effort tmp cleanup — don't mask the original error.
    try { await fs.unlink(tmp); } catch {}
    throw e;
  } finally {
    await _releaseCrossProcessLock(lockPath);
  }
}

/**
 * Serialize mutators of a given file through a per-path promise chain.
 *
 * Wraps `fn()` so only one caller touches `filePath` at a time, solving
 * the lost-update problem from concurrent load→mutate→save cycles.
 *
 * Each file path has its own lock — writes to different files proceed
 * concurrently.
 *
 * **Timeout** (Sprint 18 fix): The timeout starts when `fn` BEGINS
 * executing, not when `withFileLock` is called. This prevents queue-wait
 * time from counting against the per-operation deadline. On a loaded
 * system with a 3 MB store file and Windows antivirus, a single fsync
 * cycle can take 2-5 s — seven callers queued behind a slow op would
 * exhaust the old 30 s budget before ever starting.
 *
 * @param {string}   filePath   lock key (typically the file being mutated)
 * @param {function} fn         async mutator: () => Promise<T>
 * @param {number}   [timeoutMs=30000]  max wall-clock time for fn() itself; 0 = no timeout
 * @returns {Promise<T>}
 */
const locks = new Map();
function withFileLock(filePath, fn, timeoutMs = 30000) {
  const prev = locks.get(filePath) || Promise.resolve();

  // Chain onto the previous operation.  The timeout only starts ticking
  // once `fn` actually runs — queue-wait time is unbounded (the lock is
  // the only admission control).  If a previous operation in the chain
  // rejected, we still call `fn` so the chain keeps moving (the error is
  // swallowed in the stored chain holder below, not propagated to the
  // next queued caller).
  //
  // Manual deferred (new Promise) so the setTimeout rejection always has
  // a handler attached — no unhandledRejection even when the timer fires
  // before fn settles.
  const next = prev.then(
    () => new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          reject(new Error(`withFileLock timeout after ${timeoutMs}ms on "${filePath}"`));
        }, timeoutMs);
      }
      Promise.resolve().then(fn).then(
        (value) => { if (timer) clearTimeout(timer); resolve(value); },
        (err)  => { if (timer) clearTimeout(timer); reject(err); },
      );
    }),
    fn,  // previous op rejected → call fn anyway so the chain doesn't stall
  );

  // Swallow rejections in the chain holder so a single failed mutator
  // doesn't poison every subsequent caller. The returned `next` still
  // rejects for THIS caller — only the stored chain is sanitized.
  locks.set(filePath, next.catch(() => {}));

  return next;
}

module.exports = { atomicWriteJson, withFileLock };
