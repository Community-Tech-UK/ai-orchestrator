/**
 * Atomic file-based cross-process locking using O_EXCL.
 *
 * Inspired by Claude Code utils/computerUse/computerUseLock.ts.
 * Uses atomic file creation for acquisition, PID liveness checking
 * for stale lock recovery, and cleanup registry for shutdown safety.
 */

import * as fs from 'fs';
import { registerCleanup } from './cleanup-registry';

export interface LockHolder {
  pid: number;
  sessionId: string;
  acquiredAt: number;
  purpose?: string;
}

export type LockResult =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'blocked'; holder: LockHolder };

function getSessionId(): string {
  return `${process.pid}-${Date.now()}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryExclusiveCreate(lockPath: string, holder: LockHolder): Promise<boolean> {
  try {
    await fs.promises.writeFile(lockPath, JSON.stringify(holder), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

async function readLockHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const content = await fs.promises.readFile(lockPath, 'utf8');
    return JSON.parse(content) as LockHolder;
  } catch {
    return null;
  }
}

export async function acquireLock(lockPath: string, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<LockResult> {
  const sessionId = getSessionId();
  const holder: LockHolder = {
    pid: process.pid,
    sessionId,
    acquiredAt: Date.now(),
    purpose: options?.purpose,
  };

  const attempt = async (): Promise<LockResult> => {
    if (await tryExclusiveCreate(lockPath, holder)) {
      return makeAcquiredResult(lockPath, sessionId);
    }

    const existing = await readLockHolder(lockPath);
    if (!existing) {
      try { await fs.promises.unlink(lockPath); } catch { /* race */ }
      if (await tryExclusiveCreate(lockPath, holder)) {
        return makeAcquiredResult(lockPath, sessionId);
      }
      return { kind: 'blocked', holder: { pid: 0, sessionId: '', acquiredAt: 0, purpose: 'unknown' } };
    }

    if (existing.pid === process.pid) {
      return { kind: 'blocked', holder: existing };
    }

    if (isProcessAlive(existing.pid)) {
      return { kind: 'blocked', holder: existing };
    }

    try { await fs.promises.unlink(lockPath); } catch { /* lost race */ }
    if (await tryExclusiveCreate(lockPath, holder)) {
      return makeAcquiredResult(lockPath, sessionId);
    }

    const winner = await readLockHolder(lockPath);
    return { kind: 'blocked', holder: winner ?? existing };
  };

  if (!options?.timeoutMs) {
    return attempt();
  }

  const deadline = Date.now() + options.timeoutMs;
  const interval = options.retryIntervalMs ?? 200;

  while (Date.now() < deadline) {
    const result = await attempt();
    if (result.kind === 'acquired') return result;
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return attempt();
}

function makeAcquiredResult(lockPath: string, sessionId: string): LockResult {
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    unregister();
    try {
      const current = await readLockHolder(lockPath);
      if (current?.sessionId === sessionId) {
        await fs.promises.unlink(lockPath);
      }
    } catch {
      // Lock file already gone
    }
  };

  const unregister = registerCleanup(release);

  return { kind: 'acquired', release };
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<T> {
  const result = await acquireLock(lockPath, options);
  if (result.kind === 'blocked') {
    throw new Error(`Lock blocked by PID ${result.holder.pid} (${result.holder.purpose ?? 'unknown'})`);
  }
  try {
    return await fn();
  } finally {
    await result.release();
  }
}
