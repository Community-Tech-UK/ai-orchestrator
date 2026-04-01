import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { StuckProcessDetector } from './stuck-process-detector';

describe('StuckProcessDetector', () => {
  let detector: StuckProcessDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StuckProcessDetector();
  });

  afterEach(() => {
    detector.shutdown();
    vi.useRealTimers();
  });

  it('does not emit for idle instances', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    vi.advanceTimersByTime(1_200_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits suspect-stuck after soft timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(130_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('emits stuck after hard timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(250_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('uses longer timeouts for tool_executing state', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'tool_executing');
    // soft timeout is now 600s — no warning at 400s
    vi.advanceTimersByTime(400_000);
    expect(softHandler).not.toHaveBeenCalled();
    // should fire after 600s
    vi.advanceTimersByTime(210_000);
    expect(softHandler).toHaveBeenCalled();
  });

  it('emits stuck after hard timeout for tool_executing', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'tool_executing');
    // hard timeout is 1200s
    vi.advanceTimersByTime(1_210_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'tool_executing' })
    );
  });

  it('recordOutput resets timer and clears warning', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(100_000);
    detector.recordOutput('inst-1');
    vi.advanceTimersByTime(100_000);
    expect(softHandler).not.toHaveBeenCalled();
  });

  it('stopTracking removes instance from detection', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    detector.stopTracking('inst-1');
    vi.advanceTimersByTime(1_200_000);
    expect(handler).not.toHaveBeenCalled();
  });

  describe('process-alive deferral', () => {
    let aliveDetector: StuckProcessDetector;
    const aliveSet = new Set<string>();

    beforeEach(() => {
      aliveDetector = new StuckProcessDetector({
        isProcessAlive: (id) => aliveSet.has(id),
      });
    });

    afterEach(() => {
      aliveDetector.shutdown();
      aliveSet.clear();
    });

    it('defers soft warning when process is alive', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Base soft is 600s — at 610s the soft threshold is hit,
      // but process is alive so the warning is deferred
      vi.advanceTimersByTime(610_000);
      expect(softHandler).not.toHaveBeenCalled();

      // Still deferred at 620s (deferral 2)
      vi.advanceTimersByTime(10_000);
      expect(softHandler).not.toHaveBeenCalled();
    });

    it('extends hard timeout when process is alive', () => {
      const hardHandler = vi.fn();
      aliveDetector.on('process:stuck', hardHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Base hard is 1200s, alive multiplier doubles to 2400s
      // Should NOT fire at 1210s
      vi.advanceTimersByTime(1_210_000);
      expect(hardHandler).not.toHaveBeenCalled();

      // Should fire after 2400s
      vi.advanceTimersByTime(1_200_000);
      expect(hardHandler).toHaveBeenCalled();
    });

    it('stops deferring soft warning after max deferrals exhausted', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Base soft is 600s. Each check cycle (10s) past 600s consumes a deferral.
      // MAX_ALIVE_DEFERRALS = 3, so:
      //   t=600s → deferral 1
      //   t=610s → deferral 2
      //   t=620s → deferral 3
      //   t=630s → deferrals exhausted → soft warning emitted
      vi.advanceTimersByTime(620_000);
      expect(softHandler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(20_000);
      expect(softHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'tool_executing' })
      );
    });

    it('does not defer when process is dead', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      // Process NOT in aliveSet — no deferral

      // Base soft is 600s
      vi.advanceTimersByTime(610_000);
      expect(softHandler).toHaveBeenCalled();
    });

    it('resets deferral count on state change', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Use up some deferrals
      vi.advanceTimersByTime(620_000);

      // State change resets timer and deferrals
      aliveDetector.updateState('inst-1', 'tool_executing');

      // Timer reset — should not fire for another 600s
      vi.advanceTimersByTime(590_000);
      expect(softHandler).not.toHaveBeenCalled();
    });

    it('uses base hard timeout when process dies mid-run', () => {
      const hardHandler = vi.fn();
      aliveDetector.on('process:stuck', hardHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Process alive — hard at 2400s
      vi.advanceTimersByTime(1_000_000);
      expect(hardHandler).not.toHaveBeenCalled();

      // Process dies — hard drops to base 1200s (already elapsed > 1200s)
      aliveSet.delete('inst-1');
      vi.advanceTimersByTime(210_000);
      expect(hardHandler).toHaveBeenCalled();
    });
  });
});
