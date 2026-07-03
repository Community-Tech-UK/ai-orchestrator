import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSingleInstanceLock } from './single-instance-lock';

describe('acquireSingleInstanceLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-lock-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires the lock when none exists and writes the pid', () => {
    const lock = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 1234 });
    expect(lock).not.toBeNull();
    expect(fs.existsSync(lock!.path)).toBe(true);
    expect(fs.readFileSync(lock!.path, 'utf8').trim()).toBe('1234');
    expect(lock!.pid).toBe(1234);
  });

  it('refuses a second acquire while the primary pid is alive', () => {
    const alive = new Set([1234]);
    const isProcessAlive = (pid: number): boolean => alive.has(pid);

    const first = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 1234, isProcessAlive });
    expect(first).not.toBeNull();

    const second = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 5678, isProcessAlive });
    expect(second).toBeNull();
  });

  it('takes over a stale lock whose recorded pid is dead', () => {
    // Simulate a previous crashed worker: lockfile exists, pid not alive.
    const lockPath = path.join(dir, 'orchestrator-worker-ns_node-1.lock');
    fs.writeFileSync(lockPath, '9999\n');
    const isProcessAlive = (): boolean => false;

    const lock = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 4242, isProcessAlive });
    expect(lock).not.toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe('4242');
  });

  it('takes over a corrupt/empty lockfile', () => {
    const lockPath = path.join(dir, 'orchestrator-worker-ns_node-1.lock');
    fs.writeFileSync(lockPath, 'not-a-pid\n');

    const lock = acquireSingleInstanceLock({
      key: 'ns:node-1',
      dir,
      pid: 4242,
      isProcessAlive: () => true, // even "alive" cannot matter: pid is unparseable
    });
    expect(lock).not.toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe('4242');
  });

  it('release removes the lockfile, allowing a fresh acquire', () => {
    const isProcessAlive = (): boolean => true;
    const first = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 1234, isProcessAlive });
    expect(first).not.toBeNull();
    first!.release();
    expect(fs.existsSync(first!.path)).toBe(false);

    const second = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 5678, isProcessAlive });
    expect(second).not.toBeNull();
  });

  it('release does not delete a lock that was taken over by another process', () => {
    const first = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 1234, isProcessAlive: () => false });
    expect(first).not.toBeNull();

    // Another process reclaims the (now-stale) lock.
    const second = acquireSingleInstanceLock({ key: 'ns:node-1', dir, pid: 5678, isProcessAlive: () => false });
    expect(second).not.toBeNull();
    expect(fs.readFileSync(second!.path, 'utf8').trim()).toBe('5678');

    // The first process's late release must not remove the second's lock.
    first!.release();
    expect(fs.existsSync(second!.path)).toBe(true);
    expect(fs.readFileSync(second!.path, 'utf8').trim()).toBe('5678');
  });

  it('isolates locks by key (different nodes coexist)', () => {
    const isProcessAlive = (): boolean => true;
    const a = acquireSingleInstanceLock({ key: 'ns:node-a', dir, pid: 1, isProcessAlive });
    const b = acquireSingleInstanceLock({ key: 'ns:node-b', dir, pid: 2, isProcessAlive });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.path).not.toBe(b!.path);
  });
});
