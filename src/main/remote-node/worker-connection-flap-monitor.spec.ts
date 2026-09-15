import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  FLAP_RESET_MIN_INTERVAL_MS,
  SLOW_FLAP_THRESHOLD,
  SLOW_FLAP_WINDOW_MS,
  WorkerConnectionFlapMonitor,
} from './worker-connection-flap-monitor';

const REPLACE_GAP_MS = 20_000; // the incident's 16–32s reconnect cadence

function replace(monitor: WorkerConnectionFlapMonitor, now: number, streamEpoch: unknown = 1) {
  return monitor.record({ nodeId: 'node-1', nodeName: 'windows-pc', now, replacedLiveSocket: true, streamEpoch });
}

describe('WorkerConnectionFlapMonitor', () => {
  it('detects a slow stale-close loop that stays under the fast threshold and resets once', () => {
    const monitor = new WorkerConnectionFlapMonitor();
    const results = Array.from({ length: 12 }, (_, i) => replace(monitor, i * REPLACE_GAP_MS));

    expect(results.filter((r) => r.storm)).toHaveLength(1);
    expect(results[SLOW_FLAP_THRESHOLD - 1]).toMatchObject({
      resetConnection: true,
      storm: { nodeId: 'node-1', replacesInWindow: SLOW_FLAP_THRESHOLD, windowMs: SLOW_FLAP_WINDOW_MS },
    });
    expect(results.filter((r) => r.resetConnection)).toHaveLength(1);
    expect(monitor.describe('node-1', 11 * REPLACE_GAP_MS)).toMatchObject({
      stormActive: true,
      replacesInWindow: 12,
      lastResetAt: (SLOW_FLAP_THRESHOLD - 1) * REPLACE_GAP_MS,
    });
  });

  it('retries the reset once per rate-limit interval while the loop persists', () => {
    const monitor = new WorkerConnectionFlapMonitor();
    const resets: number[] = [];
    for (let now = 0; now <= 25 * 60_000; now += REPLACE_GAP_MS) {
      if (replace(monitor, now).resetConnection) resets.push(now);
    }
    expect(resets.length).toBe(3);
    expect(resets[1]! - resets[0]!).toBeGreaterThanOrEqual(FLAP_RESET_MIN_INTERVAL_MS);
    expect(resets[2]! - resets[1]!).toBeGreaterThanOrEqual(FLAP_RESET_MIN_INTERVAL_MS);
  });

  it('does not count a stream-epoch change (a new worker process) toward the slow storm', () => {
    const monitor = new WorkerConnectionFlapMonitor();
    const results = [1, 1, 1, 2, 2, 2].map((epoch, i) => replace(monitor, i * REPLACE_GAP_MS, epoch));
    expect(results.some((r) => r.storm || r.resetConnection)).toBe(false);
    expect(monitor.describe('node-1', 5 * REPLACE_GAP_MS).replacesInWindow).toBe(3);
  });

  it('counts grace-window re-registers for the fast storm only and never resets for them', () => {
    const monitor = new WorkerConnectionFlapMonitor();
    const results = Array.from({ length: 10 }, (_, i) =>
      monitor.record({ nodeId: 'node-1', nodeName: 'n', now: i * 1_000, replacedLiveSocket: false }));

    expect(results[9]?.storm).toMatchObject({ replacesInWindow: 10, windowMs: 60_000 });
    expect(results.some((r) => r.resetConnection)).toBe(false);
    expect(monitor.describe('node-1', 9_000)).toMatchObject({ stormActive: true, replacesInWindow: 0 });
  });

  it('clears the storm once the slow window empties', () => {
    const monitor = new WorkerConnectionFlapMonitor();
    for (let i = 0; i < SLOW_FLAP_THRESHOLD; i++) replace(monitor, i * REPLACE_GAP_MS);
    expect(monitor.describe('node-1', SLOW_FLAP_WINDOW_MS * 2)).toMatchObject({
      stormActive: false,
      replacesInWindow: 0,
    });
  });
});
