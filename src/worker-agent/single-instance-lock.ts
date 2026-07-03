import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cross-platform single-instance guard for the worker process.
 *
 * Multiple worker processes registering under the same node id evict each
 * other's coordinator sockets — the "Replacing existing socket" storm that
 * fails in-flight work (the 2026-07-03 incident, made worse by an operator
 * double-clicking the launcher). This lock ensures exactly one live worker per
 * node identity: a second launch detects the live primary and exits cleanly.
 *
 * The lock is a pidfile written atomically (`wx`). It is:
 *  - stale-safe: if the recorded pid is no longer alive, the lock is taken over;
 *  - self-releasing: `release()` removes the file only if we still own it;
 *  - dependency-light: pure `fs`, no native deps (workers must not import
 *    `electron`), so it works identically on darwin/linux/win32.
 */

export interface SingleInstanceLockOptions {
  /** Identifies the lock scope — typically `${namespace}:${nodeId}`. */
  key: string;
  /** Directory to place the lockfile. Default: os.tmpdir(). */
  dir?: string;
  /** Current process id. Injectable for tests. Default `process.pid`. */
  pid?: number;
  /**
   * Liveness probe for an existing lock holder. Injectable for tests. Default
   * uses `process.kill(pid, 0)` — a no-op signal that throws ESRCH when the pid
   * is gone and EPERM when it exists but is owned by another user (still alive).
   */
  isProcessAlive?: (pid: number) => boolean;
}

export interface SingleInstanceLock {
  /** Absolute path of the lockfile. */
  readonly path: string;
  /** The pid recorded in the lockfile (this process). */
  readonly pid: number;
  /** Release the lock, removing the file only if this process still owns it. */
  release(): void;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (stale). EPERM → process exists but not ours (alive).
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Filesystem-safe filename fragment derived from an arbitrary lock key. */
function sanitizeKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'default';
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const parsed = Number.parseInt(raw.split(/\s+/)[0] ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to acquire the single-instance lock.
 *
 * @returns a handle when acquired, or `null` when another live process already
 *   holds the lock for this key (caller should exit cleanly).
 */
export function acquireSingleInstanceLock(
  options: SingleInstanceLockOptions,
): SingleInstanceLock | null {
  const dir = options.dir ?? os.tmpdir();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const lockPath = path.join(dir, `orchestrator-worker-${sanitizeKey(options.key)}.lock`);

  const tryCreate = (): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(lockPath, `${pid}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  };

  if (tryCreate()) {
    return makeHandle(lockPath, pid);
  }

  // Lock exists. Take it over only if the recorded holder is dead/unparseable.
  const holderPid = readLockPid(lockPath);
  if (holderPid !== null && holderPid !== pid && isAlive(holderPid)) {
    return null; // A live primary already owns the node — caller exits cleanly.
  }

  // Stale (dead pid) or corrupt lockfile — reclaim it. Remove then re-create
  // atomically; if another process wins the race in between, we back off.
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    return null;
  }
  if (tryCreate()) {
    return makeHandle(lockPath, pid);
  }
  // Lost the reclaim race to a concurrent launcher — treat as "already running".
  const raceHolder = readLockPid(lockPath);
  if (raceHolder !== null && raceHolder !== pid && isAlive(raceHolder)) {
    return null;
  }
  return null;
}

function makeHandle(lockPath: string, pid: number): SingleInstanceLock {
  let released = false;
  return {
    path: lockPath,
    pid,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the file if we still own it — never delete a lock another
      // process took over after we went stale.
      if (readLockPid(lockPath) === pid) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}
