import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { describe, it, expect, vi } from 'vitest';
import {
  previousChildPidFromEnv,
  runWorkerSupervisor,
  resolveWorkerChildCommand,
  WORKER_PREVIOUS_CHILD_PID_ENV,
  workerChildEnv,
  type SupervisedChildHandle,
  type WorkerSupervisorOptions,
} from './worker-supervisor';
import { WORKER_SUPERVISED_ENV, WORKER_UPDATE_RESTART_EXIT_CODE } from './worker-self-update';

// Only the default-spawner test below uses this; every other test injects spawnChild.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

interface ExitPlan {
  code: number | null;
  signal?: NodeJS.Signals | null;
  ranMs: number;
}

/**
 * A deterministic, self-driving fake spawner. Each spawned child auto-resolves
 * its exit on the next microtask using the next queued plan, advancing an
 * injected clock by `ranMs`. Combined with a synchronous `delay` that also bumps
 * the clock, the whole supervisor loop runs to completion with no real timers.
 */
function makeHarness(exits: ExitPlan[], overrides: Partial<WorkerSupervisorOptions> = {}) {
  let clock = 0;
  let call = 0;
  const spawned: {
    childArgs: string[];
    previousChildPid: number | undefined;
    kill: ReturnType<typeof vi.fn>;
    auto: boolean;
  }[] = [];
  const delays: number[] = [];

  const spawnChild = (childArgs: string[], previousChildPid?: number): SupervisedChildHandle => {
    const idx = call++;
    const plan = exits[idx] ?? { code: 0, ranMs: 0 };
    const kill = vi.fn();
    spawned.push({ childArgs, previousChildPid, kill, auto: true });
    return {
      pid: 1000 + idx,
      onExit: (cb) => {
        queueMicrotask(() => {
          clock += plan.ranMs;
          cb({ code: plan.code, signal: plan.signal ?? null });
        });
      },
      kill,
    };
  };

  const options: WorkerSupervisorOptions = {
    childArgs: ['--config', '/tmp/x.json'],
    spawnChild,
    now: () => clock,
    delay: async (ms: number) => {
      delays.push(ms);
      clock += ms;
    },
    random: () => 0,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffFactor: 2,
    stableRuntimeMs: 60_000,
    maxRapidRestarts: 5,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };

  return { options, spawned, delays };
}

describe('runWorkerSupervisor', () => {
  it('restarts the worker after a crash, then stops on a clean exit', async () => {
    const { options, spawned } = makeHarness([
      { code: 1, ranMs: 70_000 }, // crash after a healthy run
      { code: 0, ranMs: 5_000 }, // clean exit → supervisor stops
    ]);

    const result = await runWorkerSupervisor(options);

    expect(result).toBe(0);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].childArgs).toEqual(['--config', '/tmp/x.json']);
  });

  it('tells each respawned child which child exited before it', async () => {
    const { options, spawned } = makeHarness([
      { code: 4294967295, ranMs: 17_000 }, // force-killed (Windows TerminateProcess)
      { code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 70_000 },
      { code: 0, ranMs: 5_000 },
    ], { restorePreviousBundle: () => false, bundleFingerprint: () => null });

    await runWorkerSupervisor(options);

    expect(spawned.map((child) => child.previousChildPid)).toEqual([undefined, 1000, 1001]);
  });

  it('passes the exited child\'s pid to the next child through the real spawner', async () => {
    const children: EventEmitter[] = [];
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { pid: 4000 + children.length, kill: vi.fn() });
      children.push(child);
      const code = children.length === 1 ? 4294967295 : 0; // force-killed, then a clean stop
      queueMicrotask(() => child.emit('exit', code, null));
      return child as unknown as ReturnType<typeof spawn>;
    });

    await runWorkerSupervisor({
      childArgs: [],
      delay: async () => undefined,
      random: () => 0,
      restorePreviousBundle: () => false,
      bundleFingerprint: () => null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const envs = spawnMock.mock.calls
      .map((call: unknown[]) => (call[2] as { env: NodeJS.ProcessEnv }).env);
    expect(envs).toHaveLength(2);
    expect(envs[0]).not.toHaveProperty(WORKER_PREVIOUS_CHILD_PID_ENV);
    expect(envs[1][WORKER_PREVIOUS_CHILD_PID_ENV]).toBe('4000');
  });

  it('gives up after N consecutive rapid failures', async () => {
    const { options, spawned } = makeHarness(
      [
        { code: 1, ranMs: 200 },
        { code: 1, ranMs: 200 },
        { code: 1, ranMs: 200 },
      ],
      { maxRapidRestarts: 3 },
    );

    const result = await runWorkerSupervisor(options);

    expect(result).toBe(1);
    // 3 rapid failures reaches the cap; the 4th child is never spawned.
    expect(spawned).toHaveLength(3);
  });

  it('grows the restart backoff exponentially with jitter, capped at max', async () => {
    const { options, delays } = makeHarness(
      Array.from({ length: 6 }, () => ({ code: 1, ranMs: 100 })),
      { maxRapidRestarts: 100, initialBackoffMs: 1_000, maxBackoffMs: 8_000 },
    );

    await runWorkerSupervisor({ ...options, maxRapidRestarts: 6 });

    // random()=0 → jitter = floor(base/2). base doubles each restart: 1000, 2000,
    // 4000, 8000, then capped at 8000.
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 4_000]);
  });

  it('resets the backoff after a child stays up long enough to be stable', async () => {
    const { options, delays } = makeHarness(
      [
        { code: 1, ranMs: 100 }, // rapid crash → backoff grows
        { code: 1, ranMs: 70_000 }, // stable run then crash → reset
        { code: 1, ranMs: 100 }, // rapid crash → backoff from reset base
        { code: 0, ranMs: 100 },
      ],
      { maxRapidRestarts: 10 },
    );

    await runWorkerSupervisor(options);

    // iter1 rapid crash → delay 500 (base 1000), base grows to 2000.
    // iter2 stable crash → base RESET to 1000 before its restart delay → 500.
    // iter3 rapid crash → delay 1000 (base grew to 2000 after the reset).
    // Without the reset, iter2's delay would have been 1000 (from base 2000).
    expect(delays).toEqual([500, 500, 1_000]);
  });

  it('forwards a termination signal to the running child and stops', async () => {
    const captured: { exit: ((r: { code: number | null; signal: NodeJS.Signals | null }) => void) | null } = { exit: null };
    const kill = vi.fn();
    const spawnChild = (): SupervisedChildHandle => ({
      pid: 4242,
      onExit: (cb) => {
        captured.exit = cb; // do NOT auto-resolve; the test drives the exit
      },
      kill,
    });

    const { options } = makeHarness([], { spawnChild });

    const before = process.listeners('SIGINT');
    const promise = runWorkerSupervisor(options);
    await Promise.resolve(); // let the loop spawn the first child
    await Promise.resolve();

    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);

    // Fire the supervisor's own SIGINT handler.
    (added[0] as () => void)();
    expect(kill).toHaveBeenCalledWith('SIGINT');

    // Child exits in response; supervisor should stop cleanly, not restart.
    captured.exit?.({ code: 0, signal: 'SIGINT' });
    const result = await promise;
    expect(result).toBe(0);

    // Handler is cleaned up on exit.
    expect(process.listeners('SIGINT').filter((l) => !before.includes(l))).toHaveLength(0);
  });

  it('respawns promptly after an update exit without spending the rapid-failure budget', async () => {
    const restorePreviousBundle = vi.fn(() => true);
    const { options, spawned, delays } = makeHarness(
      [
        // Six quick update exits would exceed maxRapidRestarts (5) if counted.
        ...Array.from({ length: 6 }, () => ({ code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 1_000 })),
        { code: 0, ranMs: 120_000 },
      ],
      { restorePreviousBundle, updateRestartDelayMs: 500 },
    );

    const result = await runWorkerSupervisor(options);

    expect(result).toBe(0);
    expect(spawned).toHaveLength(7);
    expect(delays).toEqual([500, 500, 500, 500, 500, 500]);
    expect(restorePreviousBundle).not.toHaveBeenCalled();
  });

  it('restores the previous bundle when the first child after an update dies before it is stable', async () => {
    const restorePreviousBundle = vi.fn(() => true);
    const { options, spawned } = makeHarness(
      [
        { code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 600_000 },
        { code: 1, ranMs: 2_000 }, // the new bundle crashes on start
        { code: 0, ranMs: 120_000 }, // the restored bundle runs
      ],
      { restorePreviousBundle },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(3);
  });

  it('keeps trying the restore when Windows refuses it once, instead of giving up', async () => {
    const restorePreviousBundle = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { options } = makeHarness(
      [
        { code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 3_600_000 },
        { code: 1, ranMs: 2_000 }, // new bundle crashes; restore refused
        { code: 1, ranMs: 2_000 }, // still the new bundle; restore succeeds now
        { code: 0, ranMs: 120_000 }, // the restored bundle runs
      ],
      { restorePreviousBundle },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).toHaveBeenCalledTimes(2);
  });

  it('does not restore after an update when the new child was stable before it crashed', async () => {
    const restorePreviousBundle = vi.fn(() => true);
    const { options } = makeHarness(
      [
        { code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 600_000 },
        { code: 1, ranMs: 90_000 }, // ran past stableRuntimeMs: an ordinary crash
        { code: 0, ranMs: 120_000 },
      ],
      { restorePreviousBundle },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).not.toHaveBeenCalled();
  });

  it('restores after a crash that respawned onto a bundle swapped in while the worker was busy', async () => {
    const restorePreviousBundle = vi.fn(() => true);
    const fingerprints = ['bundle-A', 'bundle-B', 'bundle-A'];
    const { options } = makeHarness(
      [
        { code: 1, ranMs: 600_000 }, // long, healthy run on A, then an unrelated crash
        { code: 1, ranMs: 2_000 }, // the respawn loads B, which dies at once
        { code: 0, ranMs: 120_000 },
      ],
      { restorePreviousBundle, bundleFingerprint: () => fingerprints.shift() ?? null },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).toHaveBeenCalledTimes(1);
  });

  it('does not restore a rapid failure on the same bundle that last ran stably', async () => {
    const restorePreviousBundle = vi.fn(() => true);
    const { options } = makeHarness(
      [
        { code: 1, ranMs: 600_000 },
        { code: 1, ranMs: 2_000 },
        { code: 0, ranMs: 120_000 },
      ],
      { restorePreviousBundle, bundleFingerprint: () => 'bundle-A' },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).not.toHaveBeenCalled();
  });

  it('falls back to normal crash handling when there is no previous bundle to restore', async () => {
    const restorePreviousBundle = vi.fn(() => false);
    const { options, delays } = makeHarness(
      [
        { code: WORKER_UPDATE_RESTART_EXIT_CODE, ranMs: 600_000 },
        { code: 1, ranMs: 2_000 },
        { code: 0, ranMs: 120_000 },
      ],
      { restorePreviousBundle, updateRestartDelayMs: 500 },
    );

    expect(await runWorkerSupervisor(options)).toBe(0);
    expect(restorePreviousBundle).toHaveBeenCalledTimes(1);
    // The update pause, then the ordinary crash backoff (base 1000, jitter 0 → 500).
    expect(delays).toEqual([500, 500]);
  });
});

describe('workerChildEnv', () => {
  it('marks the child as supervised without dropping the parent environment', () => {
    const env = workerChildEnv({ PATH: '/bin', AIO_WORKER_TOKEN: 'placeholder' });
    expect(env).toEqual({ PATH: '/bin', AIO_WORKER_TOKEN: 'placeholder', [WORKER_SUPERVISED_ENV]: '1' });
  });

  it('names the previous child only when there was one', () => {
    expect(workerChildEnv({ PATH: '/bin' }, 4321)[WORKER_PREVIOUS_CHILD_PID_ENV]).toBe('4321');
    expect(workerChildEnv({ PATH: '/bin', [WORKER_PREVIOUS_CHILD_PID_ENV]: '99' }))
      .not.toHaveProperty(WORKER_PREVIOUS_CHILD_PID_ENV);
  });
});

describe('previousChildPidFromEnv', () => {
  it('reads a positive pid and ignores anything else', () => {
    expect(previousChildPidFromEnv({ [WORKER_PREVIOUS_CHILD_PID_ENV]: '4321' })).toBe(4321);
    expect(previousChildPidFromEnv({})).toBeUndefined();
    expect(previousChildPidFromEnv({ [WORKER_PREVIOUS_CHILD_PID_ENV]: 'abc' })).toBeUndefined();
    expect(previousChildPidFromEnv({ [WORKER_PREVIOUS_CHILD_PID_ENV]: '0' })).toBeUndefined();
  });
});

describe('resolveWorkerChildCommand', () => {
  it('re-invokes the script when launched as `node <script>`', () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/opt/app/dist/worker-agent/index.js';
    try {
      const { exe, args } = resolveWorkerChildCommand(['--config', '/c.json']);
      expect(exe).toBe(process.execPath);
      expect(args).toEqual(['/opt/app/dist/worker-agent/index.js', '--config', '/c.json']);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});
