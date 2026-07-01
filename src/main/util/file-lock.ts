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

export type SyncLockResult =
  | { kind: 'acquired'; release: () => void }
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

function tryExclusiveCreateSync(lockPath: string, holder: LockHolder): boolean {
  try {
    fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' });
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

function readLockHolderSync(lockPath: string): LockHolder | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
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

export function acquireLockSync(lockPath: string, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): SyncLockResult {
  const sessionId = getSessionId();
  const holder: LockHolder = {
    pid: process.pid,
    sessionId,
    acquiredAt: Date.now(),
    purpose: options?.purpose,
  };

  const attempt = (): SyncLockResult => {
    if (tryExclusiveCreateSync(lockPath, holder)) {
      return makeAcquiredSyncResult(lockPath, sessionId);
    }

    const existing = readLockHolderSync(lockPath);
    if (!existing) {
      try { fs.unlinkSync(lockPath); } catch { /* race */ }
      if (tryExclusiveCreateSync(lockPath, holder)) {
        return makeAcquiredSyncResult(lockPath, sessionId);
      }
      return { kind: 'blocked', holder: { pid: 0, sessionId: '', acquiredAt: 0, purpose: 'unknown' } };
    }

    if (existing.pid === process.pid) {
      return { kind: 'blocked', holder: existing };
    }

    if (isProcessAlive(existing.pid)) {
      return { kind: 'blocked', holder: existing };
    }

    try { fs.unlinkSync(lockPath); } catch { /* lost race */ }
    if (tryExclusiveCreateSync(lockPath, holder)) {
      return makeAcquiredSyncResult(lockPath, sessionId);
    }

    const winner = readLockHolderSync(lockPath);
    return { kind: 'blocked', holder: winner ?? existing };
  };

  if (!options?.timeoutMs) {
    return attempt();
  }

  const deadline = Date.now() + options.timeoutMs;
  const interval = options.retryIntervalMs ?? 200;

  while (Date.now() < deadline) {
    const result = attempt();
    if (result.kind === 'acquired') return result;
    waitSync(interval);
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

function makeAcquiredSyncResult(lockPath: string, sessionId: string): SyncLockResult {
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    unregister();
    try {
      const current = readLockHolderSync(lockPath);
      if (current?.sessionId === sessionId) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Lock file already gone
    }
  };

  const unregister = registerCleanup(release);

  return { kind: 'acquired', release };
}

function waitSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
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

export function withLockSync<T>(lockPath: string, fn: () => T, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): T {
  const result = acquireLockSync(lockPath, options);
  if (result.kind === 'blocked') {
    throw new Error(`Lock blocked by PID ${result.holder.pid} (${result.holder.purpose ?? 'unknown'})`);
  }
  try {
    return fn();
  } finally {
    result.release();
  }
}
