import type { ChildProcess } from 'child_process';
import { Writable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFixtureRegistry } from '../../../tests/fixtures/process-fixture';
import { AcpCliAdapter } from './acp-cli-adapter';

const fixtures = new ProcessFixtureRegistry();
afterEach(() => fixtures.cleanup());

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

// Disposable local Node subprocess, with the real Base spawn/listener path.
const agent = `
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const result = request.method === 'initialize'
    ? {protocolVersion: 1, agentCapabilities: {}}
    : request.method === 'session/new' ? {sessionId: 'synthetic-session'} : {stopReason: 'end_turn'};
  if (request.id) process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result}) + '\\n');
});
`;
class NativeAdapter extends AcpCliAdapter {
  override async checkStatus() { return { available: true }; }
  getChild(): ChildProcess { return this.process!; }
  protected override spawnProcess(args: string[]): ChildProcess {
    return fixtures.track(super.spawnProcess(args));
  }
}

describe('Base native stdin error ownership through ACP', () => {
  it('reports one asynchronous non-EPIPE write error through the awaiting send', async () => {
    const adapter = new NativeAdapter({ command: process.execPath, args: ['-e', agent], workingDirectory: '/tmp', requestTimeoutMs: 2000 });
    const errors: Error[] = [];
    adapter.on('error', (error) => errors.push(error));
    await adapter.spawn();
    const proc = adapter.getChild();
    const stdin = proc.stdin as Writable;
    const failure = Object.assign(new Error('synthetic asynchronous native stream failure'), { code: 'EIO' });
    // Keep the original real stream and its production permanent listeners.
    stdin._write = (_chunk, _encoding, callback) => { queueMicrotask(() => callback(failure)); };
    try {
      await expect(adapter.sendInput('synthetic input')).rejects.toBe(failure);
      expect(errors).toEqual([failure]);
      expect(stdin.listenerCount('error')).toBe(1);
    } finally {
      const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
      await adapter.terminate(false);
      await closed;
    }
  });

  it('accepts an ordinary prompt using actual subprocess stdin callbacks', async () => {
    const adapter = new NativeAdapter({ command: process.execPath, args: ['-e', agent], workingDirectory: '/tmp', requestTimeoutMs: 2000 });
    const errors: Error[] = [];
    adapter.on('error', (error) => errors.push(error));
    await adapter.spawn();
    const proc = adapter.getChild();
    try {
      await expect(adapter.sendInput('synthetic accepted input')).resolves.toBeUndefined();
      expect(errors).toEqual([]);
      expect(proc.stdin!.listenerCount('error')).toBe(1);
    } finally {
      const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
      await adapter.terminate(false);
      await closed;
    }
  });
});
