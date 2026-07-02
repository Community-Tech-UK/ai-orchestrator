import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireLock,
  acquireLockSync,
  withLock,
  withLockSync,
  type LockHolder,
} from './file-lock';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-file-lock-'));
  lockPath = path.join(dir, 'settings.json.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeHolder(holder: LockHolder): void {
  fs.writeFileSync(lockPath, JSON.stringify(holder));
}

function liveForeignHolder(): LockHolder {
  // Our own PID reads as alive but is not our lock session, so it blocks.
  return { pid: process.pid, sessionId: 'foreign-session', acquiredAt: Date.now() - 1000, purpose: 'other-writer' };
}

/** PID of a process that has already exited (spawnSync fully reaps it). */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  expect(result.pid).toBeGreaterThan(0);
  return result.pid;
}

describe('acquireLock (async)', () => {
  it('acquires when no lock exists and releases cleanly', async () => {
    const result = await acquireLock(lockPath, { purpose: 'settings-write' });

    expect(result.kind).toBe('acquired');
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockHolder;
    expect(holder.pid).toBe(process.pid);
    expect(holder.purpose).toBe('settings-write');

    if (result.kind === 'acquired') await result.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('blocks when a live holder owns the lock', async () => {
    writeHolder(liveForeignHolder());

    const result = await acquireLock(lockPath);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.holder.purpose).toBe('other-writer');
    }
    // The foreign lock file must not be stolen or deleted.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('recovers a stale lock left by a dead process', async () => {
    writeHolder({ pid: deadPid(), sessionId: 'stale', acquiredAt: Date.now() - 60_000 });

    const result = await acquireLock(lockPath);

    expect(result.kind).toBe('acquired');
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockHolder;
    expect(holder.pid).toBe(process.pid);
    if (result.kind === 'acquired') await result.release();
  });

  it('recovers a corrupt (unparseable) lock file', async () => {
    fs.writeFileSync(lockPath, 'not-json{{{');

    const result = await acquireLock(lockPath);

    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') await result.release();
  });

  it('retries until timeout then reports blocked', async () => {
    writeHolder(liveForeignHolder());
    const started = Date.now();

    const result = await acquireLock(lockPath, { timeoutMs: 120, retryIntervalMs: 20 });

    expect(result.kind).toBe('blocked');
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('release does not delete a lock re-acquired by another session', async () => {
    const result = await acquireLock(lockPath);
    expect(result.kind).toBe('acquired');

    // Simulate: we lose the lock and another writer recreates it.
    writeHolder(liveForeignHolder());
    if (result.kind === 'acquired') await result.release();

    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe('withLock', () => {
  it('runs the function and releases afterwards', async () => {
    const value = await withLock(lockPath, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(value).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the function throws', async () => {
    await expect(withLock(lockPath, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(fs.existsSync(lockPath)).toBe(false);
    // Lock is free again for the next writer.
    const result = await acquireLock(lockPath);
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') await result.release();
  });

  it('throws a descriptive error when blocked', async () => {
    writeHolder(liveForeignHolder());

    await expect(withLock(lockPath, async () => 1)).rejects.toThrow(/Lock blocked by PID/);
  });
});

describe('acquireLockSync / withLockSync', () => {
  it('acquires and releases synchronously', () => {
    const result = acquireLockSync(lockPath, { purpose: 'settings-write' });

    expect(result.kind).toBe('acquired');
    expect(fs.existsSync(lockPath)).toBe(true);
    if (result.kind === 'acquired') result.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('recovers a stale lock from a dead process synchronously', () => {
    writeHolder({ pid: deadPid(), sessionId: 'stale', acquiredAt: Date.now() - 60_000 });

    const result = acquireLockSync(lockPath);

    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') result.release();
  });

  it('withLockSync throws when blocked and releases on error', () => {
    writeHolder(liveForeignHolder());
    expect(() => withLockSync(lockPath, () => 1)).toThrow(/Lock blocked by PID/);

    fs.unlinkSync(lockPath);
    expect(() => withLockSync(lockPath, () => {
      throw new Error('sync-boom');
    })).toThrow('sync-boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
