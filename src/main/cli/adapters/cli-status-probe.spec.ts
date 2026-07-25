import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { probeVersionStatus, type VersionStatusProbeOptions } from './cli-status-probe';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);

  /** Emit a `--version` reply and exit, as a healthy CLI would. */
  respond(output: string, code = 0): void {
    this.stdout.emit('data', Buffer.from(output));
    this.emit('close', code);
  }
}

function baseOptions(
  spawn: () => ChildProcess,
  overrides: Partial<VersionStatusProbeOptions> = {},
): VersionStatusProbeOptions {
  return {
    spawn,
    path: 'codex',
    timeoutMs: 50,
    timeoutError: 'Timeout checking Codex CLI',
    spawnError: (error) => `Failed to spawn codex: ${error.message}`,
    unavailableError: ({ output }) => `Codex CLI not found: ${output}`,
    isAvailable: ({ code, output }) => code === 0 || output.includes('codex'),
    ...overrides,
  };
}

describe('probeVersionStatus', () => {
  it('reports the CLI version when the probe answers', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => {
      setTimeout(() => child.respond('codex-cli 1.2.3'), 0);
      return child as unknown as ChildProcess;
    });

    const status = await probeVersionStatus(baseOptions(spawn));

    expect(status).toMatchObject({ available: true, version: '1.2.3', path: 'codex' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails after a single attempt when the CLI hangs on a healthy host', async () => {
    const spawn = vi.fn(() => new FakeChildProcess() as unknown as ChildProcess);

    const status = await probeVersionStatus(
      baseOptions(spawn, { isHostStarved: () => false }),
    );

    expect(status).toEqual({ available: false, error: 'Timeout checking Codex CLI' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retries once when the host is starved, so a stall cannot condemn a healthy CLI', async () => {
    const second = new FakeChildProcess();
    const spawn = vi.fn(() => {
      if (spawn.mock.calls.length === 1) {
        // First attempt: the child never gets a chance to be observed.
        return new FakeChildProcess() as unknown as ChildProcess;
      }
      setTimeout(() => second.respond('codex-cli 1.2.3'), 0);
      return second as unknown as ChildProcess;
    });

    const status = await probeVersionStatus(
      baseOptions(spawn, { isHostStarved: () => true }),
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({ available: true, version: '1.2.3' });
  });

  it('treats a late-firing timer as host starvation and retries', async () => {
    const second = new FakeChildProcess();
    const spawn = vi.fn(() => {
      if (spawn.mock.calls.length === 1) {
        return new FakeChildProcess() as unknown as ChildProcess;
      }
      setTimeout(() => second.respond('codex-cli 1.2.3'), 0);
      return second as unknown as ChildProcess;
    });
    // Probe starts at 0; the timeout callback observes its 50ms budget plus 5s
    // of lateness, which is only possible when the event loop was blocked.
    const clock = [0, 5_010, 0, 0];
    let tick = 0;

    const status = await probeVersionStatus(
      baseOptions(spawn, {
        isHostStarved: () => false,
        now: () => clock[Math.min(tick++, clock.length - 1)] ?? 0,
      }),
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({ available: true });
  });

  it('does not retry a spawn error (the CLI is genuinely missing)', async () => {
    const spawn = vi.fn(() => {
      const child = new FakeChildProcess();
      setTimeout(() => child.emit('error', new Error('spawn codex ENOENT')), 0);
      return child as unknown as ChildProcess;
    });

    const status = await probeVersionStatus(
      baseOptions(spawn, { isHostStarved: () => true }),
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(status).toEqual({
      available: false,
      error: 'Failed to spawn codex: spawn codex ENOENT',
    });
  });

  it('kills the child when the budget expires', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child as unknown as ChildProcess);

    await probeVersionStatus(
      baseOptions(spawn, { isHostStarved: () => false, killSignal: 'SIGKILL' }),
    );

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
