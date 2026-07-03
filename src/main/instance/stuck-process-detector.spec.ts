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

  it('does not escalate a paused instance, and resumes with a fresh clock', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');

    // Pause (owning node went degraded) — no escalation despite long silence.
    detector.pauseTracking('inst-1');
    vi.advanceTimersByTime(600_000);
    expect(handler).not.toHaveBeenCalled();

    // Resume (node reconnected) — the clock resets, so no immediate kill.
    detector.resumeTracking('inst-1');
    vi.advanceTimersByTime(30_000);
    expect(handler).not.toHaveBeenCalled();

    // Fresh silence past the soft threshold still escalates normally.
    vi.advanceTimersByTime(40_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('uses longer timeouts for tool_executing state', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'tool_executing');
    // soft timeout is 240s — no warning at 200s
    vi.advanceTimersByTime(200_000);
    expect(softHandler).not.toHaveBeenCalled();
    // should fire after 240s
    vi.advanceTimersByTime(50_000);
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
    // Advance to just before the 60s soft threshold, then reset via recordOutput.
    vi.advanceTimersByTime(50_000);
    detector.recordOutput('inst-1');
    // After reset, another 50s should still not trigger (50s < 60s softMs).
    vi.advanceTimersByTime(50_000);
    expect(softHandler).not.toHaveBeenCalled();
  });

  describe('evidence-hash fence (P4.5/D5)', () => {
    it('new content resets the stuck clock', () => {
      const softHandler = vi.fn();
      detector.on('process:suspect-stuck', softHandler);
      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');
      vi.advanceTimersByTime(50_000);
      detector.recordOutput('inst-1', 'first chunk');
      vi.advanceTimersByTime(50_000);
      detector.recordOutput('inst-1', 'second different chunk');
      // Each distinct output reset the 60s clock, so 50s after the last one is fine.
      vi.advanceTimersByTime(50_000);
      expect(softHandler).not.toHaveBeenCalled();
    });

    it('identical repeated content does NOT reset the clock (looping output still flagged)', () => {
      const softHandler = vi.fn();
      detector.on('process:suspect-stuck', softHandler);
      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');
      // Seed the evidence baseline.
      detector.recordOutput('inst-1', 'LOOP');
      // Repeated identical output every 20s — liveness, not progress. Must not
      // perpetually defer the soft warning (60s generating soft threshold).
      vi.advanceTimersByTime(20_000);
      detector.recordOutput('inst-1', 'LOOP');
      vi.advanceTimersByTime(20_000);
      detector.recordOutput('inst-1', 'LOOP');
      vi.advanceTimersByTime(30_000); // total ~70s since baseline, all identical
      expect(softHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
      );
    });

    it('state change resets the evidence baseline', () => {
      const softHandler = vi.fn();
      detector.on('process:suspect-stuck', softHandler);
      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');
      detector.recordOutput('inst-1', 'SAME');
      detector.updateState('inst-1', 'generating'); // baseline cleared
      // 'SAME' again now counts as new evidence (baseline was reset) → resets clock.
      vi.advanceTimersByTime(40_000);
      detector.recordOutput('inst-1', 'SAME');
      vi.advanceTimersByTime(40_000);
      expect(softHandler).not.toHaveBeenCalled();
    });
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

      // Base soft is 240s — at 250s the soft threshold is hit,
      // but process is alive so the warning is deferred
      vi.advanceTimersByTime(250_000);
      expect(softHandler).not.toHaveBeenCalled();

      // Still deferred at 260s (deferral 2)
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

    it('stops deferring soft warning after max deferrals exhausted (post-grace)', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // An alive tool_executing turn is fully suppressed during the 20min
      // grace window — no soft warning, even well past the 240s base soft.
      vi.advanceTimersByTime(1_200_000);
      expect(softHandler).not.toHaveBeenCalled();

      // Past the grace ceiling the normal soft→hard escalation resumes, with
      // the alive-deferral logic still applying: 3 deferrals (10s each) then
      // the soft warning is emitted.
      vi.advanceTimersByTime(40_000);
      expect(softHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'tool_executing' })
      );
    });

    it('emits stuck at the soft threshold when an active process is confirmed dead', () => {
      const softHandler = vi.fn();
      const hardHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.on('process:stuck', hardHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'generating');
      // Process NOT in aliveSet — no deferral

      vi.advanceTimersByTime(70_000);
      expect(softHandler).not.toHaveBeenCalled();
      expect(hardHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
      );
    });

    it('resets deferral count on state change', () => {
      const softHandler = vi.fn();
      aliveDetector.on('process:suspect-stuck', softHandler);
      aliveDetector.startTracking('inst-1');
      aliveDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Use up some deferrals
      vi.advanceTimersByTime(260_000);

      // State change resets timer and deferrals
      aliveDetector.updateState('inst-1', 'tool_executing');

      // Timer reset — should not fire for another 240s
      vi.advanceTimersByTime(230_000);
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

  describe('tool_executing alive grace', () => {
    let graceDetector: StuckProcessDetector;
    const aliveSet = new Set<string>();

    beforeEach(() => {
      graceDetector = new StuckProcessDetector({
        isProcessAlive: (id) => aliveSet.has(id),
      });
    });

    afterEach(() => {
      graceDetector.shutdown();
      aliveSet.clear();
    });

    it('suppresses the false stuck warning for a live, long MCP tool call', () => {
      // Reproduces the logged incident: state=tool_executing, processAlive=true,
      // ~630s of silence (a codex/gemini MCP sub-agent review). No warning, no kill.
      const softHandler = vi.fn();
      const hardHandler = vi.fn();
      graceDetector.on('process:suspect-stuck', softHandler);
      graceDetector.on('process:stuck', hardHandler);
      graceDetector.startTracking('inst-1');
      graceDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      vi.advanceTimersByTime(700_000); // 700s > the 630s false alarm
      expect(softHandler).not.toHaveBeenCalled();
      expect(hardHandler).not.toHaveBeenCalled();
    });

    it('resumes escalation past the grace ceiling (genuine hang still caught)', () => {
      const softHandler = vi.fn();
      const hardHandler = vi.fn();
      graceDetector.on('process:suspect-stuck', softHandler);
      graceDetector.on('process:stuck', hardHandler);
      graceDetector.startTracking('inst-1');
      graceDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');

      // Within grace (20min) → silent.
      vi.advanceTimersByTime(1_200_000);
      expect(softHandler).not.toHaveBeenCalled();
      expect(hardHandler).not.toHaveBeenCalled();

      // Past grace → soft warning fires (after deferrals).
      vi.advanceTimersByTime(40_000);
      expect(softHandler).toHaveBeenCalled();

      // Hard kill still lands at the alive ceiling (1200s × 2 = 2400s).
      vi.advanceTimersByTime(1_200_000);
      expect(hardHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'tool_executing' })
      );
    });

    it('does not apply the grace to a dead process in a tool call', () => {
      // tool_executing but process NOT alive — kill at the base hard timeout.
      const hardHandler = vi.fn();
      graceDetector.on('process:stuck', hardHandler);
      graceDetector.startTracking('inst-1');
      graceDetector.updateState('inst-1', 'tool_executing');
      // not added to aliveSet

      vi.advanceTimersByTime(1_210_000); // base hard = 1200s, no alive multiplier
      expect(hardHandler).toHaveBeenCalled();
    });

    it('does not apply the grace to the generating state', () => {
      // A live process that should be streaming tokens but is silent stays suspect.
      const softHandler = vi.fn();
      graceDetector.on('process:suspect-stuck', softHandler);
      graceDetector.startTracking('inst-1');
      graceDetector.updateState('inst-1', 'generating');
      aliveSet.add('inst-1');

      vi.advanceTimersByTime(130_000); // well under the 20min grace, but generating isn't graced
      expect(softHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
      );
    });
  });

  describe('host-load scaling', () => {
    let loadDetector: StuckProcessDetector;
    const aliveSet = new Set<string>();
    let multiplier = 1;

    beforeEach(() => {
      multiplier = 1;
      loadDetector = new StuckProcessDetector({
        isProcessAlive: (id) => aliveSet.has(id),
        getTimeoutMultiplier: () => multiplier,
      });
    });

    afterEach(() => {
      loadDetector.shutdown();
      aliveSet.clear();
    });

    it('stretches the hard timeout for an alive process while the host is overloaded', () => {
      const hardHandler = vi.fn();
      loadDetector.on('process:stuck', hardHandler);
      loadDetector.startTracking('inst-1');
      loadDetector.updateState('inst-1', 'generating');
      aliveSet.add('inst-1');
      multiplier = 3;

      // Base hard 240s × alive 2 × load 3 = 1440s. Not stuck at 1000s.
      vi.advanceTimersByTime(1_000_000);
      expect(hardHandler).not.toHaveBeenCalled();

      // Fires once the scaled threshold passes.
      vi.advanceTimersByTime(500_000);
      expect(hardHandler).toHaveBeenCalled();
    });

    it('does NOT scale dead-process detection — a missing PID is conclusive', () => {
      const stuckHandler = vi.fn();
      loadDetector.on('process:stuck', stuckHandler);
      loadDetector.startTracking('inst-1');
      loadDetector.updateState('inst-1', 'generating');
      multiplier = 4; // heavy load, but the process is gone

      // Dead process fires at the UNSCALED soft threshold (60s for generating).
      vi.advanceTimersByTime(70_000);
      expect(stuckHandler).toHaveBeenCalledTimes(1);
    });

    it('scales the tool_executing alive grace ceiling', () => {
      const softHandler = vi.fn();
      const hardHandler = vi.fn();
      loadDetector.on('process:suspect-stuck', softHandler);
      loadDetector.on('process:stuck', hardHandler);
      loadDetector.startTracking('inst-1');
      loadDetector.updateState('inst-1', 'tool_executing');
      aliveSet.add('inst-1');
      multiplier = 2;

      // Past the base grace ceiling (1200s) but under the scaled one (2400s):
      // escalation stays suppressed.
      vi.advanceTimersByTime(1_300_000);
      expect(softHandler).not.toHaveBeenCalled();
      expect(hardHandler).not.toHaveBeenCalled();
    });

    it('clamps and survives a broken multiplier supplier', () => {
      const stuckHandler = vi.fn();
      const throwingDetector = new StuckProcessDetector({
        isProcessAlive: () => true,
        getTimeoutMultiplier: () => {
          throw new Error('boom');
        },
      });
      throwingDetector.on('process:stuck', stuckHandler);
      throwingDetector.startTracking('inst-1');
      throwingDetector.updateState('inst-1', 'generating');

      // Falls back to multiplier 1: hard 240s × alive 2 = 480s.
      vi.advanceTimersByTime(490_000);
      expect(stuckHandler).toHaveBeenCalled();
      throwingDetector.shutdown();
    });
  });

  describe('external activity suppression', () => {
    let externalDetector: StuckProcessDetector;
    const activeSet = new Set<string>();

    beforeEach(() => {
      externalDetector = new StuckProcessDetector({
        hasExternalActivity: (id) => activeSet.has(id),
      });
    });

    afterEach(() => {
      externalDetector.shutdown();
      activeSet.clear();
    });

    it('does not emit stuck events while external orchestration work is active', () => {
      const softHandler = vi.fn();
      const hardHandler = vi.fn();
      externalDetector.on('process:suspect-stuck', softHandler);
      externalDetector.on('process:stuck', hardHandler);
      externalDetector.startTracking('inst-1');
      externalDetector.updateState('inst-1', 'generating');
      activeSet.add('inst-1');

      vi.advanceTimersByTime(250_000);

      expect(softHandler).not.toHaveBeenCalled();
      expect(hardHandler).not.toHaveBeenCalled();

      activeSet.delete('inst-1');
      vi.advanceTimersByTime(130_000);

      expect(softHandler).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
      );
      expect(hardHandler).not.toHaveBeenCalled();
    });
  });

  describe('sleep/wake detection', () => {
    // Sleep detection requires a large wall-clock gap between checkAll() calls.
    // Fake timers fire intervals incrementally (no gap), so we invoke checkAll()
    // directly after setting lastCheckTime far in the past.

    it('resets all tracker timers after detecting system sleep', () => {
      const stuckHandler = vi.fn();
      detector.on('process:stuck', stuckHandler);
      detector.on('process:suspect-stuck', stuckHandler);

      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');

      // Simulate: lastOutputAt was 200s ago, lastCheckTime was 120s ago (system slept)
      const d = detector as any;
      const now = Date.now();
      d.trackers.get('inst-1')!.lastOutputAt = now - 200_000;
      d.lastCheckTime = now - 120_000;

      // This checkAll() sees a 120s gap (>> 60s threshold) → resets timers
      d.checkAll();

      expect(stuckHandler).not.toHaveBeenCalled();
      // Verify timer was actually reset to ~now
      expect(now - d.trackers.get('inst-1')!.lastOutputAt).toBeLessThan(1000);
    });

    it('does not reset timers for normal check intervals', () => {
      const softHandler = vi.fn();
      detector.on('process:suspect-stuck', softHandler);

      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');

      // Advance past soft timeout (120s) in normal 10s increments — no sleep detected
      vi.advanceTimersByTime(130_000);
      expect(softHandler).toHaveBeenCalled();
    });

    it('resets timers for all tracked instances on sleep', () => {
      const stuckHandler = vi.fn();
      detector.on('process:stuck', stuckHandler);
      detector.on('process:suspect-stuck', stuckHandler);

      detector.startTracking('inst-1');
      detector.startTracking('inst-2');
      detector.updateState('inst-1', 'generating');
      detector.updateState('inst-2', 'tool_executing');

      // Simulate system sleep: both instances had output 300s ago
      const d = detector as any;
      const now = Date.now();
      d.trackers.get('inst-1')!.lastOutputAt = now - 300_000;
      d.trackers.get('inst-2')!.lastOutputAt = now - 300_000;
      d.lastCheckTime = now - 120_000;

      d.checkAll();

      // Sleep detected → timers reset, no stuck events
      expect(stuckHandler).not.toHaveBeenCalled();
      expect(now - d.trackers.get('inst-1')!.lastOutputAt).toBeLessThan(1000);
      expect(now - d.trackers.get('inst-2')!.lastOutputAt).toBeLessThan(1000);
    });

    it('clears warning flags and deferral counts on sleep reset', () => {
      const d = detector as any;
      detector.startTracking('inst-1');
      detector.updateState('inst-1', 'generating');

      // Manually set flags that should be cleared
      const tracker = d.trackers.get('inst-1')!;
      tracker.softWarningEmitted = true;
      tracker.interactivePromptWarningEmitted = true;
      tracker.aliveDeferrals = 3;
      d.lastCheckTime = Date.now() - 120_000;

      d.checkAll();

      expect(tracker.softWarningEmitted).toBe(false);
      expect(tracker.interactivePromptWarningEmitted).toBe(false);
      expect(tracker.aliveDeferrals).toBe(0);
    });
  });
});
