import { describe, it, expect, vi } from 'vitest';
import {
  runWorkerSupervisor,
  resolveWorkerChildCommand,
  type SupervisedChildHandle,
  type WorkerSupervisorOptions,
} from './worker-supervisor';

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
  const spawned: { childArgs: string[]; kill: ReturnType<typeof vi.fn>; auto: boolean }[] = [];
  const delays: number[] = [];

  const spawnChild = (childArgs: string[]): SupervisedChildHandle => {
    const idx = call++;
    const plan = exits[idx] ?? { code: 0, ranMs: 0 };
    const kill = vi.fn();
    spawned.push({ childArgs, kill, auto: true });
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
