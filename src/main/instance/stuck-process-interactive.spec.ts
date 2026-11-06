import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StuckProcessDetector } from './stuck-process-detector';

describe('interactive prompt true/false fixtures', () => {
  let detector: StuckProcessDetector;
  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StuckProcessDetector({ isProcessAlive: () => true, getTimeoutMultiplier: () => 1 });
    detector.startTracking('session');
    detector.updateState('session', 'tool_executing');
  });
  afterEach(() => { detector.shutdown(); vi.useRealTimers(); });

  it('true: recent stderr and at least 45 seconds of stdout silence emits once during live-tool grace', () => {
    const interactive = vi.fn();
    const stuck = vi.fn();
    detector.on('process:interactive-prompt', interactive);
    detector.on('process:suspect-stuck', stuck);
    vi.advanceTimersByTime(40_000);
    detector.recordStderr('session');
    vi.advanceTimersByTime(10_000);
    expect(interactive).toHaveBeenCalledExactlyOnceWith({ instanceId: 'session', state: 'tool_executing', stdoutSilentMs: 50_000, lastStderrMs: 10_000 });
    detector.recordStderr('session');
    vi.advanceTimersByTime(10_000);
    expect(interactive).toHaveBeenCalledTimes(1);
    expect(stuck).not.toHaveBeenCalled();
  });

  it.each(['long silent tool', 'old stderr', 'new stdout', 'generating', 'paused'] as const)('false: %s does not imply interactive input', fixture => {
    const interactive = vi.fn();
    detector.on('process:interactive-prompt', interactive);
    if (fixture === 'old stderr') { vi.advanceTimersByTime(1000); detector.recordStderr('session'); }
    vi.advanceTimersByTime(40_000);
    if (fixture !== 'long silent tool' && fixture !== 'old stderr') detector.recordStderr('session');
    if (fixture === 'new stdout') detector.recordOutput('session', 'continued work');
    if (fixture === 'generating') detector.updateState('session', 'generating');
    if (fixture === 'paused') detector.pauseTracking('session');
    vi.advanceTimersByTime(10_000);
    expect(interactive).not.toHaveBeenCalled();
  });
});
