import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkerConnectionStatus,
  noAnswerMessage,
  readWorkerConnectionStatus,
  WorkerConnectionStatusWriter,
  workerConnectionStatusPath,
} from './worker-connection-status';

describe('worker connection status', () => {
  let dir: string;
  let configPath: string;
  let now: number;
  const clock = (): number => now;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-status-'));
    configPath = path.join(dir, 'worker-node.json');
    now = 1_000_000;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function read(options: Parameters<typeof readWorkerConnectionStatus>[1] = {}) {
    return readWorkerConnectionStatus(configPath, {
      now: clock,
      isProcessAlive: () => true,
      ...options,
    });
  }

  it('writes the report beside the worker config', () => {
    expect(workerConnectionStatusPath(configPath)).toBe(path.join(dir, 'worker-node.status.json'));
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 })
      .set('connected', { coordinatorUrl: 'ws://mac:4878' });

    const raw = JSON.parse(fs.readFileSync(workerConnectionStatusPath(configPath), 'utf-8'));
    expect(raw).toMatchObject({ pid: 42, nodeId: 'node-1', state: 'connected', coordinatorUrl: 'ws://mac:4878' });
    expect(read()).toEqual({
      state: 'connected',
      coordinatorUrl: 'ws://mac:4878',
      since: now,
      updatedAt: now,
      alive: true,
      stale: false,
    });
  });

  it('keeps showing a failure while the worker retries', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('connecting', { coordinatorUrl: 'ws://mac:4878' });
    writer.set('unreachable', { message: 'No answer from ws://mac:4878.' });
    writer.set('connecting');
    writer.set('reconnecting');
    expect(read()?.state).toBe('unreachable');

    writer.set('registering');
    writer.set('rejected', { message: 'pairing token expired' });
    writer.set('reconnecting');
    writer.set('connecting');
    writer.set('registering');
    expect(read()).toMatchObject({ state: 'rejected', message: 'pairing token expired' });

    writer.set('connected');
    expect(read()?.state).toBe('connected');
  });

  it('says connecting only for the first attempt, then reconnecting after a drop', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('connecting');
    writer.set('connected');
    writer.set('reconnecting');
    writer.set('connecting');
    expect(read()?.state).toBe('reconnecting');
  });

  it('refreshes an unchanged report on touch, at most every 30 seconds', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('connected');
    now += 10_000;
    writer.touch();
    expect(read()?.updatedAt).toBe(1_000_000);
    now += 25_000;
    writer.touch();
    expect(read()).toMatchObject({ since: 1_000_000, updatedAt: now });
  });

  it('marks a live worker that stopped reporting as stale', () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 }).set('connected');
    now += 3 * 60_000;
    expect(read()).toMatchObject({ state: 'connected', stale: true });
  });

  it('ignores a report from an exited worker, except a recent failure', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('connected');
    expect(read({ isProcessAlive: () => false })).toBeNull();

    writer.set('failed', { message: 'This computer has no address for the main Harness.' });
    expect(read({ isProcessAlive: () => false })).toMatchObject({ state: 'failed', alive: false });
    now += 11 * 60_000;
    expect(read({ isProcessAlive: () => false })).toBeNull();
  });

  it('ignores a report written for another pairing', () => {
    new WorkerConnectionStatusWriter(configPath, 'old-node', { now: clock, pid: 42 }).set('connected');
    expect(read({ expectedNodeId: 'new-node' })).toBeNull();
    expect(read({ expectedNodeId: 'old-node' })?.state).toBe('connected');
  });

  it('returns null for a missing or malformed report', () => {
    expect(read()).toBeNull();
    fs.writeFileSync(workerConnectionStatusPath(configPath), '{"state":"connected"');
    expect(read()).toBeNull();
    fs.writeFileSync(workerConnectionStatusPath(configPath), JSON.stringify({ pid: 1, nodeId: 'n', state: 'weird', since: 1, updatedAt: 1 }));
    expect(read()).toBeNull();
  });

  it('shortens long reasons to one line', () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 })
      .set('rejected', { message: `bad\n${'word '.repeat(100)}` });
    const message = read()?.message ?? '';
    expect(message.startsWith('bad word')).toBe(true);
    expect(message.endsWith('...')).toBe(true);
    expect(message.length).toBe(300);
  });

  it('stops claiming connected once the main Harness goes silent, and recovers when it answers', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    const ping = vi.fn();
    writer.set('connected', { coordinatorUrl: 'ws://mac:4878' });

    now += 30_000;
    writer.noteContact();
    now += 30_000;
    expect(writer.heartbeat(ping)).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(read()?.state).toBe('connected');

    // No message or pong for longer than the silence budget: tells the worker to drop the socket.
    now += 20_000;
    expect(writer.heartbeat(ping)).toBe(true);
    expect(read()).toMatchObject({ state: 'unreachable', message: 'It stopped answering.', coordinatorUrl: 'ws://mac:4878' });
    // Only once; the reconnect takes over from here.
    expect(writer.heartbeat(ping)).toBe(false);

    // A close while silent keeps the failure; a pong brings it back.
    writer.set('reconnecting');
    expect(read()?.state).toBe('unreachable');
    writer.noteContact();
    expect(read()?.state).toBe('connected');
  });

  it('allows at least three heartbeats of silence when heartbeats are slow', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42, heartbeatIntervalMs: 60_000 });
    writer.set('connected');
    now += 61_000;
    expect(writer.heartbeat(() => undefined)).toBe(false);
    now += 120_000;
    expect(writer.heartbeat(() => undefined)).toBe(true);
  });

  it('does not turn a failed connect into connected on stray contact', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('unreachable', { message: 'No answer from ws://mac:4878.' });
    writer.noteContact();
    expect(read()?.state).toBe('unreachable');
  });

  it('survives a ping that throws on a closing socket', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 });
    writer.set('connected');
    expect(() => writer.heartbeat(() => { throw new Error('WebSocket is not open'); })).not.toThrow();
  });

  it('hides anything shaped like a credential in a reason', () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 })
      .set('rejected', { message: 'token 8f3a9c2e41b7d6f05a1e9c3b7d2f4a6e8c0b1d3f is revoked' });
    expect(read()?.message).toBe('token [hidden] is revoked');
    expect(fs.readFileSync(workerConnectionStatusPath(configPath), 'utf-8')).not.toContain('8f3a9c2e41b7');
  });

  it("removes this worker's own credentials from a reason, whatever their shape", () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', {
      now: clock,
      pid: 42,
      secrets: () => ['short-pass-1', undefined, ''],
    }).set('rejected', { message: 'credential short-pass-1 was revoked' });
    expect(read()?.message).toBe('credential [hidden] was revoked');
  });

  it('keeps long host names readable', () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 })
      .set('unreachable', { message: noAnswerMessage(['ws://noahs-macbook-pro.tail7f3a2b.ts.net:4878', 'ws://192.168.1.20:4878']) });
    expect(read()?.message).toBe('No answer from noahs-macbook-pro.tail7f3a2b.ts.net:4878, 192.168.1.20:4878.');
  });

  it('clears the report, and tolerates there being none', () => {
    new WorkerConnectionStatusWriter(configPath, 'node-1', { now: clock, pid: 42 }).set('failed', { message: 'old' });
    clearWorkerConnectionStatus(configPath);
    expect(fs.existsSync(workerConnectionStatusPath(configPath))).toBe(false);
    expect(() => clearWorkerConnectionStatus(configPath)).not.toThrow();
  });

  it('never throws when the report cannot be written', () => {
    const writer = new WorkerConnectionStatusWriter(configPath, 'node-1', {
      writeFile: () => { throw new Error('disk full'); },
    });
    expect(() => writer.set('connected')).not.toThrow();
  });
});
