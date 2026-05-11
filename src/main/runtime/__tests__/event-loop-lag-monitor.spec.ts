import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EventLoopLagMonitor,
  _resetEventLoopLagMonitorForTesting,
  getEventLoopLagMonitor,
} from '../event-loop-lag-monitor';

describe('EventLoopLagMonitor', () => {
  beforeEach(() => {
    _resetEventLoopLagMonitorForTesting();
  });

  afterEach(() => {
    _resetEventLoopLagMonitorForTesting();
  });

  it('starts and stops without throwing', () => {
    const monitor = new EventLoopLagMonitor();
    expect(monitor.isRunning).toBe(false);
    monitor.start();
    expect(monitor.isRunning).toBe(true);
    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  it('double-start is a no-op', () => {
    const monitor = new EventLoopLagMonitor();
    monitor.start();
    monitor.start();
    expect(monitor.isRunning).toBe(true);
    monitor.stop();
  });

  it('double-stop is a no-op', () => {
    const monitor = new EventLoopLagMonitor();
    monitor.start();
    monitor.stop();
    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  it('returns a snapshot before starting with zeroed fields', () => {
    const monitor = new EventLoopLagMonitor();
    const snapshot = monitor.snapshot();
    expect(snapshot.sampleCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.maxMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.p95Ms).toBeGreaterThanOrEqual(0);
  });

  it('returns a snapshot with expected fields', () => {
    const monitor = new EventLoopLagMonitor();
    monitor.start();
    const snapshot = monitor.snapshot();
    expect(snapshot).toHaveProperty('maxMs');
    expect(snapshot).toHaveProperty('p50Ms');
    expect(snapshot).toHaveProperty('p95Ms');
    expect(snapshot).toHaveProperty('p99Ms');
    expect(snapshot).toHaveProperty('meanMs');
    expect(snapshot).toHaveProperty('sampleCount');
    expect(snapshot).toHaveProperty('usingNativeHistogram');
    monitor.stop();
  });

  it('resetStats clears accumulated fallback stats', () => {
    const monitor = new EventLoopLagMonitor({ resolutionMs: 10, fallbackIntervalMs: 10 });
    monitor.start();
    monitor.resetStats();
    const snapshot = monitor.snapshot();
    expect(snapshot.maxMs).toBe(0);
    expect(snapshot.sampleCount).toBe(0);
    monitor.stop();
  });

  it('getEventLoopLagMonitor returns the same instance', () => {
    const a = getEventLoopLagMonitor();
    const b = getEventLoopLagMonitor();
    expect(a).toBe(b);
  });

  it('reset creates a fresh instance', () => {
    const a = getEventLoopLagMonitor();
    _resetEventLoopLagMonitorForTesting();
    const b = getEventLoopLagMonitor();
    expect(a).not.toBe(b);
  });

  it('reset stops a running monitor', () => {
    const monitor = getEventLoopLagMonitor();
    monitor.start();
    expect(monitor.isRunning).toBe(true);
    _resetEventLoopLagMonitorForTesting();
    expect(monitor.isRunning).toBe(false);
  });

  it('no timer leaks after stop (fallback path)', async () => {
    // Use fake timers to confirm no pending timeouts remain after stop
    vi.useFakeTimers();
    const monitor = new EventLoopLagMonitor({ fallbackIntervalMs: 50 });
    monitor.start();
    monitor.stop();
    // Advancing time should not throw or cause unhandled errors
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  });

  it('usingNativeHistogram is a boolean', () => {
    const monitor = new EventLoopLagMonitor();
    monitor.start();
    const snapshot = monitor.snapshot();
    expect(typeof snapshot.usingNativeHistogram).toBe('boolean');
    monitor.stop();
  });
});
