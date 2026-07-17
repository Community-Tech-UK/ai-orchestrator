import { beforeEach, describe, expect, it } from 'vitest';
import { CacheAnalyticsService } from './cache-analytics-service';

const T0 = 1_700_000_000_000;

describe('CacheAnalyticsService', () => {
  let service: CacheAnalyticsService;

  beforeEach(() => {
    CacheAnalyticsService._resetForTesting();
    service = CacheAnalyticsService.getInstance();
  });

  function recordHealthyTurns(instanceId: string, count: number, startAt = T0): void {
    for (let i = 0; i < count; i++) {
      service.recordTurn(instanceId, {
        input: 1_000,
        cacheRead: 9_000,
        cacheWrite: 100,
        at: startAt + i * 60_000,
      });
    }
  }

  it('accumulates ratio samples and reports them oldest-first', () => {
    recordHealthyTurns('i1', 3);
    const report = service.getReport('i1');
    expect(report.samples).toHaveLength(3);
    expect(report.samples[0].ratio).toBeCloseTo(0.9);
    expect(report.samples[0].at).toBeLessThan(report.samples[2].at);
    expect(report.lastBreak).toBeUndefined();
  });

  it('ignores turns with no input or cacheRead signal', () => {
    service.recordTurn('i1', { input: 0, cacheRead: 0, cacheWrite: 0, at: T0 });
    expect(service.getReport('i1').samples).toHaveLength(0);
  });

  it('flags a cache break when the ratio collapses without the prompt shrinking', () => {
    recordHealthyTurns('i1', 5);
    // Same prompt size, cache went cold: ratio 0.9 → 0.0.
    service.recordTurn('i1', {
      input: 10_000,
      cacheRead: 0,
      cacheWrite: 9_500,
      at: T0 + 5 * 60_000,
    });
    const report = service.getReport('i1');
    expect(report.lastBreak).toBeDefined();
    expect(report.lastBreak!.ratio).toBe(0);
    expect(report.lastBreak!.trailingMedian).toBeCloseTo(0.9);
    expect(report.lastBreak!.probableCause).toBeUndefined();
  });

  it('does not flag a break when the prompt shrank (ratio drop is legitimate)', () => {
    recordHealthyTurns('i1', 5);
    // Fresh short prompt after e.g. a compaction: total size collapsed too.
    service.recordTurn('i1', {
      input: 500,
      cacheRead: 0,
      cacheWrite: 400,
      at: T0 + 5 * 60_000,
    });
    expect(service.getReport('i1').lastBreak).toBeUndefined();
  });

  it('correlates a break with the most recent config event inside the window', () => {
    recordHealthyTurns('i1', 5);
    service.noteConfigEvent('i1', 'MCP settings change', T0 + 4 * 60_000 + 1_000);
    service.noteConfigEvent('i1', 'model change', T0 + 4 * 60_000 + 30_000);
    service.recordTurn('i1', {
      input: 10_000,
      cacheRead: 0,
      cacheWrite: 9_500,
      at: T0 + 5 * 60_000,
    });
    expect(service.getReport('i1').lastBreak?.probableCause).toBe('model change');
  });

  it('ignores config events older than the correlation window', () => {
    recordHealthyTurns('i1', 5);
    service.noteConfigEvent('i1', 'model change', T0 - 60 * 60_000);
    service.recordTurn('i1', {
      input: 10_000,
      cacheRead: 0,
      cacheWrite: 9_500,
      at: T0 + 5 * 60_000,
    });
    expect(service.getReport('i1').lastBreak?.probableCause).toBeUndefined();
  });

  it('needs a minimum history before it will call anything a break', () => {
    recordHealthyTurns('i1', 2);
    service.recordTurn('i1', {
      input: 10_000,
      cacheRead: 0,
      cacheWrite: 9_000,
      at: T0 + 2 * 60_000,
    });
    expect(service.getReport('i1').lastBreak).toBeUndefined();
  });

  it('applies global config events to every tracked instance', () => {
    recordHealthyTurns('a', 5);
    recordHealthyTurns('b', 5, T0 + 1_000);
    service.noteGlobalConfigEvent('MCP settings change', T0 + 4 * 60_000 + 30_000);
    for (const id of ['a', 'b']) {
      service.recordTurn(id, {
        input: 10_000,
        cacheRead: 0,
        cacheWrite: 9_500,
        at: T0 + 5 * 60_000,
      });
      expect(service.getReport(id).lastBreak?.probableCause).toBe('MCP settings change');
    }
  });

  it('drops state when an instance is removed and bounds retained samples', () => {
    recordHealthyTurns('i1', 250);
    expect(service.getReport('i1').samples.length).toBeLessThanOrEqual(60);
    service.removeInstance('i1');
    expect(service.getReport('i1').samples).toHaveLength(0);
  });
});
