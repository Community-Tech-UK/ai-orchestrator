import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mocked = {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
  return { ...mocked, default: mocked };
});

import { connectToAppServer } from './app-server-client';
import { unwrapSignalFence } from '../../../sandbox/signal-fence';

function makeFakeProc(options?: { failExitCode?: number; stderr?: string }): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    killed: boolean;
    unref: () => void;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  proc.killed = false;
  proc.unref = () => undefined;

  if (options?.failExitCode !== undefined) {
    if (options.stderr) {
      proc.stderr.write(options.stderr);
    }
    process.nextTick(() => proc.emit('exit', options.failExitCode, null));
    return proc as unknown as ChildProcess;
  }

  proc.stdin.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === 'initialize' && message.id !== undefined) {
        proc.stdout.write(JSON.stringify({ id: message.id, result: { capabilities: {} } }) + '\n');
      }
    }
  });
  proc.stdin.on('finish', () => {
    queueMicrotask(() => proc.emit('exit', 0, null));
  });

  return proc as unknown as ChildProcess;
}

describe('isolated app-server spawn output limit', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('passes -c tool_output_token_limit=6000 on the isolated app-server spawn', async () => {
    spawnMock.mockImplementation(() => makeFakeProc());

    const client = await connectToAppServer('/tmp/project', { disableBroker: true });
    try {
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const first = unwrapSignalFence(
        spawnMock.mock.calls[0]?.[0] as string,
        spawnMock.mock.calls[0]?.[1] as string[],
      );
      expect(first.command).toBe('codex');
      expect(first.args).toEqual([
        '-c',
        'tool_output_token_limit=6000',
        'app-server',
      ]);
      expect(client.getOutputLimitState()).toBe('applied');
    } finally {
      await client.close();
    }
  });

  it('spawns its own raw app-server for a fence-off session even when a broker is advertised', async () => {
    spawnMock.mockImplementation(() => makeFakeProc());
    const previous = process.env['CODEX_COMPANION_APP_SERVER_ENDPOINT'];
    process.env['CODEX_COMPANION_APP_SERVER_ENDPOINT'] = 'unix:/tmp/not-a-real-broker.sock';
    try {
      const client = await connectToAppServer('/tmp/project', { signalFence: false });
      try {
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0]?.[0]).toBe('codex');
        expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-c', 'tool_output_token_limit=6000', 'app-server']);
      } finally {
        await client.close();
      }
    } finally {
      if (previous === undefined) delete process.env['CODEX_COMPANION_APP_SERVER_ENDPOINT'];
      else process.env['CODEX_COMPANION_APP_SERVER_ENDPOINT'] = previous;
    }
  });

  it('retries once without the override when Codex rejects it', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({
        failExitCode: 2,
        stderr: 'error: unknown override tool_output_token_limit',
      }))
      .mockImplementationOnce(() => makeFakeProc());

    const client = await connectToAppServer('/tmp/project', { disableBroker: true });
    try {
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(unwrapSignalFence(
        spawnMock.mock.calls[0]?.[0] as string,
        spawnMock.mock.calls[0]?.[1] as string[],
      ).args).toEqual([
        '-c',
        'tool_output_token_limit=6000',
        'app-server',
      ]);
      expect(unwrapSignalFence(
        spawnMock.mock.calls[1]?.[0] as string,
        spawnMock.mock.calls[1]?.[1] as string[],
      ).args).toEqual(['app-server']);
      expect(client.getOutputLimitState()).toBe('unsupported');
    } finally {
      await client.close();
    }
  });
});
