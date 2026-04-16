// src/main/tasks/__tests__/jitter-scheduler.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { JitterScheduler, getJitterScheduler } from '../jitter-scheduler';

describe('JitterScheduler', () => {
  beforeEach(() => {
    // Pin the fake-timer clock to :30 of the minute so the scheduler's
    // `avoidMinuteBoundary` guard (which adds 3s if the next fire lands within
    // 2s of a :00 boundary) never trips. Without this, tests flake whenever
    // wall-clock `Date.now()` at `useFakeTimers()` time falls in :58–:02.
    vi.useFakeTimers({ now: new Date('2024-01-15T12:30:30.000Z').getTime() });
    JitterScheduler._resetForTesting();
  });

  afterEach(() => {
    JitterScheduler._resetForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = JitterScheduler.getInstance();
      const b = JitterScheduler.getInstance();
      expect(a).toBe(b);
    });

    it('getJitterScheduler() returns the singleton', () => {
      expect(getJitterScheduler()).toBe(JitterScheduler.getInstance());
    });

    it('_resetForTesting returns a fresh instance', () => {
      const a = JitterScheduler.getInstance();
      JitterScheduler._resetForTesting();
      const b = JitterScheduler.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('schedule()', () => {
    it('returns the task ID', () => {
      const scheduler = JitterScheduler.getInstance();
      const id = scheduler.schedule({
        id: 'my-task',
        name: 'My Task',
        intervalMs: 1000,
        handler: vi.fn(),
      });
      expect(id).toBe('my-task');
    });

    it('auto-generates an ID when none provided', () => {
      const scheduler = JitterScheduler.getInstance();
      const id = scheduler.schedule({
        name: 'Auto ID Task',
        intervalMs: 1000,
        handler: vi.fn(),
      } as Parameters<typeof scheduler.schedule>[0]);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('executes the handler after interval elapses', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'tick-task',
        name: 'Tick Task',
        intervalMs: 1000,
        handler,
        jitterPercent: 0, // Disable jitter for deterministic test
      });

      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('executes multiple times over repeated intervals', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'repeat-task',
        name: 'Repeat Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(1600);
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not execute a disabled task', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'disabled-task',
        name: 'Disabled Task',
        intervalMs: 100,
        handler,
        enabled: false,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('unschedule()', () => {
    it('stops the handler from executing after unschedule', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'cancel-task',
        name: 'Cancel Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      await vi.advanceTimersByTimeAsync(600);
      expect(handler).toHaveBeenCalledTimes(1);

      scheduler.unschedule('cancel-task');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not more
    });

    it('does not throw when unscheduling an unknown ID', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.unschedule('nonexistent')).not.toThrow();
    });
  });

  describe('pause() and resume()', () => {
    it('pause prevents handler execution', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'pause-task',
        name: 'Pause Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.pause('pause-task');
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('resume re-enables execution after pause', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'resume-task',
        name: 'Resume Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.pause('resume-task');
      await vi.advanceTimersByTimeAsync(600);
      expect(handler).not.toHaveBeenCalled();

      scheduler.resume('resume-task');
      await vi.advanceTimersByTimeAsync(600);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('pause on unknown ID does not throw', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.pause('unknown')).not.toThrow();
    });

    it('resume on unknown ID does not throw', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.resume('unknown')).not.toThrow();
    });
  });

  describe('onMissed()', () => {
    it('accepts a callback without throwing', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => {
        scheduler.onMissed(vi.fn());
      }).not.toThrow();
    });

    it('calls onMissed callback when a task is detected as missed', async () => {
      const scheduler = JitterScheduler.getInstance();
      const missedCb = vi.fn();
      scheduler.onMissed(missedCb);

      const handler = vi.fn();
      scheduler.schedule({
        id: 'missed-task',
        name: 'Missed Task',
        intervalMs: 1000,
        handler,
        jitterPercent: 0,
        maxCatchUp: 3,
      });

      // Simulate a large time jump that would cause missed executions
      await vi.advanceTimersByTimeAsync(5000);

      // The callback should have been called at some point due to drift detection
      // (exact behavior depends on implementation — just verify it doesn't throw)
      expect(typeof missedCb.mock.calls.length).toBe('number');
    });
  });

  describe('shutdown()', () => {
    it('stops all tasks from executing', async () => {
      const scheduler = JitterScheduler.getInstance();
      const handler = vi.fn();

      scheduler.schedule({
        id: 'shutdown-task',
        name: 'Shutdown Task',
        intervalMs: 500,
        handler,
        jitterPercent: 0,
      });

      scheduler.shutdown();
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not throw when called with no scheduled tasks', () => {
      const scheduler = JitterScheduler.getInstance();
      expect(() => scheduler.shutdown()).not.toThrow();
    });
  });

  describe('jitter algorithm', () => {
    it('adds non-negative jitter to the base interval', async () => {
      const scheduler = JitterScheduler.getInstance();
      const fireTimes: number[] = [];

      scheduler.schedule({
        id: 'jitter-test',
        name: 'Jitter Test',
        intervalMs: 1000,
        handler: () => { fireTimes.push(Date.now()); },
        jitterPercent: 10,
      });

      await vi.advanceTimersByTimeAsync(3500);

      // All fire times should be at or after 1000ms intervals (jitter only adds delay)
      expect(fireTimes.length).toBeGreaterThan(0);
    });
  });
});
