import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SystemLoadMonitor,
  getSystemLoadMonitor,
  getLoadWatchdogMultiplier,
  _resetSystemLoadMonitorForTesting,
} from './system-load-monitor';

describe('SystemLoadMonitor', () => {
  let nowMs: number;
  const now = () => nowMs;

  beforeEach(() => {
    nowMs = 1_000_000;
    _resetSystemLoadMonitorForTesting();
  });

  afterEach(() => {
    _resetSystemLoadMonitorForTesting();
  });

  function monitorWithLoad(load1: number, cpuCount = 8): SystemLoadMonitor {
    return new SystemLoadMonitor({
      readLoadAvg: () => [load1, load1, load1],
      cpuCount,
      now,
    });
  }

  describe('load tiers', () => {
    it('returns 1 when the host is calm', () => {
      const monitor = monitorWithLoad(4, 8); // 0.5 per core
      expect(monitor.getWatchdogMultiplier()).toBe(1);
      expect(monitor.isOverloaded()).toBe(false);
    });

    it('returns 2 at >=1.5 load per core', () => {
      const monitor = monitorWithLoad(16, 8); // 2.0 per core
      expect(monitor.getWatchdogMultiplier()).toBe(2);
      expect(monitor.isOverloaded()).toBe(true);
    });

    it('returns 3 at >=3 load per core', () => {
      const monitor = monitorWithLoad(32, 8); // 4.0 per core
      expect(monitor.getWatchdogMultiplier()).toBe(3);
    });

    it('returns 4 at >=6 load per core (2026-07-01 regime)', () => {
      const monitor = monitorWithLoad(290, 24); // ~12 per core
      expect(monitor.getWatchdogMultiplier()).toBe(4);
    });
  });

  describe('sampling cache', () => {
    it('caches loadavg reads within the TTL and refreshes after it', () => {
      let load = 0;
      let reads = 0;
      const monitor = new SystemLoadMonitor({
        readLoadAvg: () => {
          reads++;
          return [load, load, load];
        },
        cpuCount: 4,
        now,
        sampleTtlMs: 5_000,
      });

      expect(monitor.getWatchdogMultiplier()).toBe(1);
      expect(reads).toBe(1);

      // Load spikes, but within the TTL the cached sample is used.
      load = 40;
      nowMs += 1_000;
      expect(monitor.getWatchdogMultiplier()).toBe(1);
      expect(reads).toBe(1);

      // Past the TTL the new sample is read: 40/4 = 10 per core → 4x.
      nowMs += 5_000;
      expect(monitor.getWatchdogMultiplier()).toBe(4);
      expect(reads).toBe(2);
    });
  });

  describe('event-loop stall floor', () => {
    it('raises the multiplier to the stall floor even when loadavg is calm', () => {
      const monitor = monitorWithLoad(0, 8);
      expect(monitor.getWatchdogMultiplier()).toBe(1);

      monitor.reportEventLoopStall(3_000);
      expect(monitor.getWatchdogMultiplier()).toBe(2);
      expect(monitor.getSnapshot().recentEventLoopStall).toBe(true);
    });

    it('does not lower a higher load-based multiplier', () => {
      const monitor = monitorWithLoad(290, 24);
      monitor.reportEventLoopStall(3_000);
      expect(monitor.getWatchdogMultiplier()).toBe(4);
    });

    it('ignores sub-second stalls', () => {
      const monitor = monitorWithLoad(0, 8);
      monitor.reportEventLoopStall(500);
      expect(monitor.getWatchdogMultiplier()).toBe(1);
    });

    it('decays after the recency window', () => {
      const monitor = monitorWithLoad(0, 8);
      monitor.reportEventLoopStall(3_000);
      expect(monitor.getWatchdogMultiplier()).toBe(2);

      nowMs += 61_000;
      expect(monitor.getWatchdogMultiplier()).toBe(1);
    });
  });

  describe('robustness', () => {
    it('treats a throwing loadavg reader as calm', () => {
      const monitor = new SystemLoadMonitor({
        readLoadAvg: () => {
          throw new Error('boom');
        },
        cpuCount: 8,
        now,
      });
      expect(monitor.getWatchdogMultiplier()).toBe(1);
    });

    it('treats NaN/negative loadavg (e.g. Windows) as calm', () => {
      expect(monitorWithLoad(NaN).getWatchdogMultiplier()).toBe(1);
      expect(monitorWithLoad(-1).getWatchdogMultiplier()).toBe(1);
    });
  });

  describe('singleton + test guard', () => {
    it('getSystemLoadMonitor returns a stable instance until reset', () => {
      const a = getSystemLoadMonitor();
      expect(getSystemLoadMonitor()).toBe(a);
      _resetSystemLoadMonitorForTesting();
      expect(getSystemLoadMonitor()).not.toBe(a);
    });

    it('getLoadWatchdogMultiplier returns 1 under vitest regardless of host load', () => {
      // This test intentionally runs on whatever machine executes the suite;
      // the VITEST guard must make the default accessor deterministic.
      expect(getLoadWatchdogMultiplier()).toBe(1);
    });
  });
});
