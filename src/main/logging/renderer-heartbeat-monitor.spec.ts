import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  webContentsById: new Map<number, { isDestroyed: () => boolean }>(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => mocks.webContentsById.get(id),
  },
}));

vi.mock('./logger', () => ({
  getLogger: () => mocks.logger,
}));

import {
  HEARTBEAT_STALL_THRESHOLD_MS,
  HEARTBEAT_WATCHDOG_INTERVAL_MS,
  RendererHeartbeatMonitor,
} from './renderer-heartbeat-monitor';

describe('RendererHeartbeatMonitor', () => {
  let monitor: RendererHeartbeatMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.webContentsById.clear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    monitor = new RendererHeartbeatMonitor();
    mocks.webContentsById.set(7, { isDestroyed: () => false });
  });

  afterEach(() => {
    monitor._resetForTesting();
    vi.useRealTimers();
  });

  function beatAt(seq: number): void {
    monitor.beat(7, { seq, sentAt: Date.now() });
  }

  it('tracks a renderer after its first beat and reports no stall while beats flow', () => {
    beatAt(0);
    expect(monitor.isTracking(7)).toBe(true);

    for (let seq = 1; seq <= 5; seq++) {
      vi.advanceTimersByTime(2_000);
      beatAt(seq);
    }
    expect(monitor.isStalled(7)).toBe(false);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('opens a stall episode (one error log) when beats stop while the renderer is alive', () => {
    beatAt(0);
    vi.advanceTimersByTime(HEARTBEAT_STALL_THRESHOLD_MS + HEARTBEAT_WATCHDOG_INTERVAL_MS);

    expect(monitor.isStalled(7)).toBe(true);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error.mock.calls[0][0]).toMatch(/heartbeat stalled/i);

    // A continuing stall must not spam a log entry per watchdog tick.
    vi.advanceTimersByTime(HEARTBEAT_WATCHDOG_INTERVAL_MS * 5);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs a recovery with stall duration and missed-beat count when beats resume', () => {
    beatAt(0);
    vi.advanceTimersByTime(HEARTBEAT_STALL_THRESHOLD_MS + HEARTBEAT_WATCHDOG_INTERVAL_MS);
    expect(monitor.isStalled(7)).toBe(true);

    // Renderer thaws: several beats' worth of time passed, next seq jumps.
    beatAt(8);
    expect(monitor.isStalled(7)).toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = mocks.logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toMatch(/recovered/i);
    expect(meta['stalledMs']).toBeGreaterThanOrEqual(HEARTBEAT_STALL_THRESHOLD_MS);
    expect(meta['missedBeats']).toBe(7);

    // A fresh stall after recovery logs again (new episode).
    vi.advanceTimersByTime(HEARTBEAT_STALL_THRESHOLD_MS + HEARTBEAT_WATCHDOG_INTERVAL_MS);
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });

  it('silently drops a renderer whose webContents is gone (not a freeze)', () => {
    beatAt(0);
    mocks.webContentsById.delete(7);
    vi.advanceTimersByTime(HEARTBEAT_STALL_THRESHOLD_MS + HEARTBEAT_WATCHDOG_INTERVAL_MS);

    expect(monitor.isTracking(7)).toBe(false);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('forget() stops tracking so a destroyed renderer never logs a stall', () => {
    beatAt(0);
    monitor.forget(7);
    vi.advanceTimersByTime(HEARTBEAT_STALL_THRESHOLD_MS + HEARTBEAT_WATCHDOG_INTERVAL_MS);

    expect(monitor.isTracking(7)).toBe(false);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
