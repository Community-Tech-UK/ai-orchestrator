// src/main/process/__tests__/graceful-shutdown.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  GracefulShutdownManager,
  getGracefulShutdownManager,
  ShutdownPriority,
} from '../graceful-shutdown';

describe('GracefulShutdownManager', () => {
  beforeEach(() => {
    GracefulShutdownManager._resetForTesting();
  });

  afterEach(() => {
    GracefulShutdownManager._resetForTesting();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = GracefulShutdownManager.getInstance();
      const b = GracefulShutdownManager.getInstance();
      expect(a).toBe(b);
    });

    it('getGracefulShutdownManager() returns the singleton', () => {
      const mgr = getGracefulShutdownManager();
      expect(mgr).toBe(GracefulShutdownManager.getInstance());
    });

    it('_resetForTesting creates a fresh instance', () => {
      const a = GracefulShutdownManager.getInstance();
      GracefulShutdownManager._resetForTesting();
      const b = GracefulShutdownManager.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('register()', () => {
    it('registers a phase handler without error', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'test-phase',
          priority: ShutdownPriority.STOP_BACKGROUND,
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          handler: () => {},
        });
      }).not.toThrow();
    });

    it('accepts async handlers', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'async-phase',
          priority: ShutdownPriority.FLUSH_IO,
          handler: async () => { await Promise.resolve(); },
        });
      }).not.toThrow();
    });

    it('accepts sync flag', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        mgr.register({
          name: 'sync-phase',
          priority: ShutdownPriority.SESSION_SYNC,
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          handler: () => {},
          sync: true,
        });
      }).not.toThrow();
    });
  });

  describe('execute()', () => {
    it('runs phases in priority order (lowest number first)', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const order: string[] = [];

      mgr.register({ name: 'last', priority: 50, handler: () => { order.push('last'); } });
      mgr.register({ name: 'first', priority: 0, handler: () => { order.push('first'); } });
      mgr.register({ name: 'middle', priority: 20, handler: () => { order.push('middle'); } });

      const report = await mgr.execute();

      expect(order).toEqual(['first', 'middle', 'last']);
      expect(report.phases).toHaveLength(3);
    });

    it('marks completed phases as completed', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      mgr.register({ name: 'ok', priority: 10, handler: () => {} });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'ok');

      expect(phase?.status).toBe('completed');
    });

    it('marks timed-out phases as timeout', async () => {
      vi.useFakeTimers();
      const mgr = GracefulShutdownManager.getInstance();

      mgr.register({
        name: 'slow',
        priority: 10,
        budgetMs: 100,
        handler: () => new Promise<void>(resolve => setTimeout(resolve, 5000)),
      });

      const executePromise = mgr.execute();
      await vi.runAllTimersAsync();
      const report = await executePromise;

      const phase = report.phases.find(p => p.name === 'slow');
      expect(phase?.status).toBe('timeout');
      vi.useRealTimers();
    });

    it('marks erroring phases as error and includes the error', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      mgr.register({
        name: 'broken',
        priority: 10,
        handler: () => { throw new Error('boom'); },
      });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'broken');

      expect(phase?.status).toBe('error');
      expect(phase?.error?.message).toBe('boom');
    });

    it('continues executing phases after one fails', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: string[] = [];

      mgr.register({ name: 'fails', priority: 10, handler: () => { throw new Error('fail'); } });
      mgr.register({ name: 'ok', priority: 20, handler: () => { ran.push('ok'); } });

      const report = await mgr.execute();

      expect(ran).toContain('ok');
      expect(report.phases).toHaveLength(2);
    });

    it('returns a report with totalDurationMs', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      mgr.register({ name: 'quick', priority: 10, handler: () => {} });

      const report = await mgr.execute();

      expect(typeof report.totalDurationMs).toBe('number');
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('report includes orphanDetected field', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const report = await mgr.execute();
      expect(typeof report.orphanDetected).toBe('boolean');
    });

    it('records durationMs for each phase', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      mgr.register({ name: 'timed', priority: 10, handler: () => {} });

      const report = await mgr.execute();
      const phase = report.phases.find(p => p.name === 'timed');

      expect(typeof phase?.durationMs).toBe('number');
      expect(phase!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('runs multiple phases at same priority sequentially', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const log: string[] = [];

      mgr.register({ name: 'a', priority: 10, handler: async () => { log.push('a'); } });
      mgr.register({ name: 'b', priority: 10, handler: async () => { log.push('b'); } });

      await mgr.execute();

      expect(log).toContain('a');
      expect(log).toContain('b');
    });

    it('returns empty phases array when no handlers registered', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const report = await mgr.execute();
      expect(report.phases).toEqual([]);
    });
  });

  describe('ShutdownPriority constants', () => {
    it('SESSION_SYNC has priority 0', () => {
      expect(ShutdownPriority.SESSION_SYNC).toBe(0);
    });

    it('SIGNAL_CHILDREN has priority 10', () => {
      expect(ShutdownPriority.SIGNAL_CHILDREN).toBe(10);
    });

    it('FLUSH_IO has priority 20', () => {
      expect(ShutdownPriority.FLUSH_IO).toBe(20);
    });

    it('STOP_BACKGROUND has priority 30', () => {
      expect(ShutdownPriority.STOP_BACKGROUND).toBe(30);
    });

    it('TERMINATE_INSTANCES has priority 40', () => {
      expect(ShutdownPriority.TERMINATE_INSTANCES).toBe(40);
    });

    it('FINAL_CLEANUP has priority 50', () => {
      expect(ShutdownPriority.FINAL_CLEANUP).toBe(50);
    });
  });

  describe('backward compat: registerCleanup bridge', () => {
    it('exposes registerCleanupCompat that wraps into FINAL_CLEANUP phase', () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: boolean[] = [];

      mgr.registerCleanupCompat(async () => { ran.push(true); });
      expect(ran).toHaveLength(0); // Not run yet
    });

    it('compat handlers run during execute()', async () => {
      const mgr = GracefulShutdownManager.getInstance();
      const ran: boolean[] = [];

      mgr.registerCleanupCompat(async () => { ran.push(true); });
      await mgr.execute();

      expect(ran).toHaveLength(1);
    });
  });

  describe('onOrphanDetected', () => {
    it('accepts a callback without throwing', () => {
      const mgr = GracefulShutdownManager.getInstance();
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        mgr.onOrphanDetected(() => {});
      }).not.toThrow();
    });
  });
});
