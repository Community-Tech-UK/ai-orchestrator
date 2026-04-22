import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmStartManager, type WarmStartDeps } from './warm-start-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<WarmStartDeps> = {}): WarmStartDeps {
  return {
    spawnAdapter: vi.fn().mockResolvedValue({ __fakeAdapter: true }),
    killAdapter: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WarmStartManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // preWarm
  // -------------------------------------------------------------------------

  describe('preWarm', () => {
    it('spawns a process with the correct provider and workingDirectory', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);

      await manager.preWarm('claude', '/project');

      expect(deps.spawnAdapter).toHaveBeenCalledOnce();
      expect(deps.spawnAdapter).toHaveBeenCalledWith('claude', {
        workingDirectory: '/project',
      });
      expect(manager.hasWarm('claude')).toBe(true);
    });

    it('kills an existing warm process before spawning a new one', async () => {
      const firstAdapter = { id: 'first' };
      let callCount = 0;
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockImplementation(() => {
          callCount += 1;
          return Promise.resolve({ id: `adapter-${callCount}` });
        }),
      });

      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');
      // Grab the first adapter reference before it's replaced
      const adapterAfterFirst = (deps.spawnAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;

      await manager.preWarm('claude', '/project2');

      // killAdapter should have been called once (for the first warm process)
      expect(deps.killAdapter).toHaveBeenCalledOnce();
      expect(deps.killAdapter).toHaveBeenCalledWith(await adapterAfterFirst);
      // spawnAdapter called twice overall
      expect(deps.spawnAdapter).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when the manager is disabled', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      manager.setEnabled(false);

      await manager.preWarm('claude', '/project');

      expect(deps.spawnAdapter).not.toHaveBeenCalled();
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('logs a warning and does not throw when spawning fails', async () => {
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockRejectedValue(new Error('spawn failed')),
      });
      const manager = new WarmStartManager(deps);

      await expect(manager.preWarm('claude', '/project')).resolves.toBeUndefined();
      expect(manager.hasWarm('claude')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // consume
  // -------------------------------------------------------------------------

  describe('consume', () => {
    it('returns the adapter when provider matches', async () => {
      const fakeAdapter = { id: 'my-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      const result = manager.consume('claude');

      expect(result).toBe(fakeAdapter);
    });

    it('clears the warm slot after a successful consume', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      manager.consume('claude');

      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('returns null when provider does not match and keeps the warm process', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      const result = manager.consume('codex');

      expect(result).toBeNull();
      // Warm process for 'claude' should still be alive
      expect(manager.hasWarm('claude')).toBe(true);
    });

    it('returns null when workingDirectory does not match and keeps the warm process', async () => {
      const fakeAdapter = { id: 'my-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project-a');

      const result = manager.consume('claude', '/project-b');

      expect(result).toBeNull();
      // Warm process should still be held
      expect(manager.hasWarm('claude', '/project-a')).toBe(true);
    });

    it('returns the adapter when provider AND workingDirectory both match', async () => {
      const fakeAdapter = { id: 'my-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      const result = manager.consume('claude', '/project');

      expect(result).toBe(fakeAdapter);
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('matches Windows workingDirectory values across separator and case differences', async () => {
      const fakeAdapter = { id: 'my-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', 'C:\\Users\\Alice\\Work\\My-App');

      const result = manager.consume('claude', 'c:/users/alice/work/my-app/');

      expect(result).toBe(fakeAdapter);
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('returns null when there is no warm process', () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);

      const result = manager.consume('claude');

      expect(result).toBeNull();
    });

    it('cancels the expiry timer when consumed', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      manager.consume('claude');

      // Advance past 5 minutes — killAdapter should NOT be called because
      // the warm process was already consumed (timer cancelled).
      vi.advanceTimersByTime(6 * 60 * 1000);
      await vi.runAllTimersAsync();

      expect(deps.killAdapter).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // hasWarm
  // -------------------------------------------------------------------------

  describe('hasWarm', () => {
    it('returns true when a warm process exists for the provider', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      expect(manager.hasWarm('claude')).toBe(true);
    });

    it('returns false when no warm process exists', () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);

      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('returns false when a warm process exists for a different provider', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      expect(manager.hasWarm('codex')).toBe(false);
    });

    it('returns true when provider and workingDirectory both match', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      expect(manager.hasWarm('claude', '/project')).toBe(true);
    });

    it('treats Windows workingDirectory filters as equivalent across separator and case differences', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', 'C:\\Users\\Alice\\Work\\My-App');

      expect(manager.hasWarm('claude', 'c:/users/alice/work/my-app/')).toBe(true);
    });

    it('returns false when provider matches but workingDirectory does not', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project-a');

      expect(manager.hasWarm('claude', '/project-b')).toBe(false);
    });

    it('returns true when provider matches and no workingDirectory filter given', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      // Without workingDirectory arg, only provider is checked
      expect(manager.hasWarm('claude')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // setEnabled
  // -------------------------------------------------------------------------

  describe('setEnabled', () => {
    it('kills the warm process immediately when disabled', async () => {
      const fakeAdapter = { id: 'my-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      manager.setEnabled(false);
      // Allow the fire-and-forget kill to settle
      await vi.runAllTimersAsync();

      expect(deps.killAdapter).toHaveBeenCalledOnce();
      expect(deps.killAdapter).toHaveBeenCalledWith(fakeAdapter);
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('allows preWarm again after being re-enabled', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      manager.setEnabled(false);

      // Still disabled — preWarm should be no-op
      await manager.preWarm('claude', '/project');
      expect(deps.spawnAdapter).not.toHaveBeenCalled();

      manager.setEnabled(true);

      await manager.preWarm('claude', '/project');
      expect(deps.spawnAdapter).toHaveBeenCalledOnce();
      expect(manager.hasWarm('claude')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Timer expiry
  // -------------------------------------------------------------------------

  describe('timer expiry', () => {
    it('kills the warm process after 5 minutes', async () => {
      const fakeAdapter = { id: 'expiring-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      // Advance exactly 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      await vi.runAllTimersAsync();

      expect(deps.killAdapter).toHaveBeenCalledOnce();
      expect(deps.killAdapter).toHaveBeenCalledWith(fakeAdapter);
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('does not kill if less than 5 minutes have passed', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      // Advance to just before the 5-minute mark and flush only timers that
      // are due by this point (do NOT use runAllTimersAsync which would also
      // fire future timers).
      vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000); // 4m59s
      // Let any microtasks/promises that fired settle.
      await Promise.resolve();

      expect(deps.killAdapter).not.toHaveBeenCalled();
      expect(manager.hasWarm('claude')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('kills the warm process when one exists', async () => {
      const fakeAdapter = { id: 'cleanup-adapter' };
      const deps = makeDeps({
        spawnAdapter: vi.fn().mockResolvedValue(fakeAdapter),
      });
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      await manager.cleanup();

      expect(deps.killAdapter).toHaveBeenCalledOnce();
      expect(deps.killAdapter).toHaveBeenCalledWith(fakeAdapter);
      expect(manager.hasWarm('claude')).toBe(false);
    });

    it('is idempotent — calling twice does not throw or double-kill', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);
      await manager.preWarm('claude', '/project');

      await manager.cleanup();
      await manager.cleanup(); // second call should be a no-op

      expect(deps.killAdapter).toHaveBeenCalledOnce();
    });

    it('is a no-op when there is no warm process', async () => {
      const deps = makeDeps();
      const manager = new WarmStartManager(deps);

      await expect(manager.cleanup()).resolves.toBeUndefined();
      expect(deps.killAdapter).not.toHaveBeenCalled();
    });
  });
});
