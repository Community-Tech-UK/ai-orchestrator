import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warmCodememWithTimeout, type WarmCodememTarget } from './warm-codemem';

function makeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('warmCodememWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when codemem is disabled without calling warmWorkspace', async () => {
    const target: WarmCodememTarget = {
      isEnabled: () => false,
      warmWorkspace: vi.fn(),
    };
    const logger = makeLogger();

    await warmCodememWithTimeout(target, {
      workspacePath: '/project',
      timeoutMs: 2500,
      logger,
    });

    expect(target.warmWorkspace).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves and logs success when warmWorkspace finishes before the timeout', async () => {
    const target: WarmCodememTarget = {
      isEnabled: () => true,
      warmWorkspace: vi
        .fn()
        .mockResolvedValue({ ready: true, filePath: '/project/src/main.ts' }),
    };
    const logger = makeLogger();

    await warmCodememWithTimeout(target, {
      workspacePath: '/project',
      timeoutMs: 2500,
      logger,
    });

    expect(target.warmWorkspace).toHaveBeenCalledWith('/project');
    expect(logger.info).toHaveBeenCalledWith(
      'Codemem workspace warm-up completed',
      expect.objectContaining({
        workspacePath: '/project',
        ready: true,
        representativeFile: '/project/src/main.ts',
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a warning when warmWorkspace rejects, without rethrowing', async () => {
    const target: WarmCodememTarget = {
      isEnabled: () => true,
      warmWorkspace: vi.fn().mockRejectedValue(new Error('LSP crashed')),
    };
    const logger = makeLogger();

    await warmCodememWithTimeout(target, {
      workspacePath: '/project',
      timeoutMs: 2500,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Codemem workspace warm-up failed; continuing without blocking spawn',
      expect.objectContaining({
        workspacePath: '/project',
        error: 'LSP crashed',
      }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('stops waiting after `timeoutMs` even if warmWorkspace never resolves', async () => {
    // This is the real regression guard: on saturated main-process event loops
    // (e.g. several restored instances streaming output concurrently), the
    // codemem warm-up could run arbitrarily long and block adapter.spawn().
    // The helper must time out and return so the spawn critical path is
    // never blocked past `timeoutMs`.
    let settled = false;
    const target: WarmCodememTarget = {
      isEnabled: () => true,
      // Never-resolving promise simulates a hung warm-up.
      warmWorkspace: vi.fn(() => new Promise(() => undefined)),
    };
    const logger = makeLogger();

    const racePromise = warmCodememWithTimeout(target, {
      workspacePath: '/project',
      timeoutMs: 2500,
      logger,
    }).then(() => {
      settled = true;
    });

    // Before the timeout fires, the helper must still be pending.
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);

    // After the timeout fires, the helper resolves even though warmWorkspace
    // never did.
    await vi.advanceTimersByTimeAsync(2);
    await racePromise;
    expect(settled).toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      'Codemem workspace warm-up exceeded timeout; continuing spawn without blocking',
      expect.objectContaining({
        workspacePath: '/project',
        timeoutMs: 2500,
      }),
    );
  });

  it('swallows a late warmWorkspace rejection after timing out (no unhandled rejection)', async () => {
    let rejectWarm!: (reason: Error) => void;
    const warmPromise = new Promise<never>((_resolve, reject) => {
      rejectWarm = reject;
    });
    const target: WarmCodememTarget = {
      isEnabled: () => true,
      warmWorkspace: vi.fn(() => warmPromise),
    };
    const logger = makeLogger();

    const unhandled = vi.fn();
    const originalHandler = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', unhandled);
    try {
      const racePromise = warmCodememWithTimeout(target, {
        workspacePath: '/project',
        timeoutMs: 2500,
        logger,
      });

      // Fire the timeout first.
      await vi.advanceTimersByTimeAsync(2500);
      await racePromise;

      // Now let the hung warm-up reject. If the helper didn't attach a
      // `.catch(() => undefined)` to the in-flight warmPromise, this would
      // surface as an unhandled rejection on the next microtask tick.
      rejectWarm(new Error('late failure'));

      // Flush microtasks so Node can observe any unhandled rejection.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const listener of originalHandler) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
  });

  it('clears the timeout handle when warmWorkspace resolves first', async () => {
    // A dangling `setTimeout` handle would keep the Node event loop alive
    // past what this helper promises. Assert clearTimeout is called.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const target: WarmCodememTarget = {
      isEnabled: () => true,
      warmWorkspace: vi.fn().mockResolvedValue({ ready: false, filePath: null }),
    };
    const logger = makeLogger();

    await warmCodememWithTimeout(target, {
      workspacePath: '/project',
      timeoutMs: 5000,
      logger,
    });

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
