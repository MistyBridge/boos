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
const path = require('node:path');

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

  try {
    // 1. Serialize
    const json = JSON.stringify(data, null, 2);

    // 2. Write tmp file + fsync for durability.
    //    fs.writeFile alone does NOT guarantee the data hits disk before
    //    rename — the OS may still hold it in the buffer cache. We open,
    //    write, sync, close to force it through.
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.write(json, 0, 'utf-8');
      await fh.sync(); // fsync / FlushFileBuffers — data is now durable
    } finally {
      await fh.close();
    }

    // 3. Backup: keep the last-known-good copy as <file>.bak.
    //    This saves us if the new write turns out to be logically
    //    corrupted (e.g. a bug in the serialization path). The .bak is a
    //    plain copy, not atomic, but it's best-effort — if copyFile
    //    fails because the target doesn't exist yet (first write), we
    //    silently continue.
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    // 4. Atomic rename onto the real path.
    await fs.rename(tmp, filePath);
  } catch (e) {
    // Best-effort tmp cleanup — don't mask the original error.
    try { await fs.unlink(tmp); } catch {}
    throw e;
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
 * @param {string}   filePath   lock key (typically the file being mutated)
 * @param {function} fn         async mutator: () => Promise<T>
 * @param {number}   [timeoutMs=30000]  max wait for the lock; 0 = no timeout
 * @returns {Promise<T>}
 */
const locks = new Map();
function withFileLock(filePath, fn, timeoutMs = 30000) {
  const prev = locks.get(filePath) || Promise.resolve();

  let timer;
  const timed = timeoutMs > 0
    ? new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`withFileLock timeout after ${timeoutMs}ms on "${filePath}"`));
        }, timeoutMs);
      })
    : null;

  const next = prev.then(fn, fn).finally(() => {
    if (timer) clearTimeout(timer);
  });

  // Swallow rejections in the chain holder so a single failed mutator
  // doesn't poison every subsequent caller. The returned `next` still
  // rejects for THIS caller — only the stored chain is sanitized.
  locks.set(filePath, next.catch(() => {}));

  // Race the actual work against the timeout (if set), but always let
  // fn's rejection propagate in preference to the timeout.
  if (timed) {
    return Promise.race([
      next,
      timed.then(() => {
        throw new Error(`withFileLock timeout after ${timeoutMs}ms on "${filePath}"`);
      }),
    ]);
  }
  return next;
}

module.exports = { atomicWriteJson, withFileLock };
