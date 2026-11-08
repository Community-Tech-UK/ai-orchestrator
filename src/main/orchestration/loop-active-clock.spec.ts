import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { loopActiveElapsedMs, pauseLoopGlobalClock, resumeLoopGlobalClock } from './loop-active-clock';

function state(): LoopState {
  return { startedAt: 0, endedAt: null } as LoopState;
}

describe('loop active elapsed time', () => {
  it('keeps old checkpoints on their existing elapsed-time calculation', () => {
    const loop = state();
    expect(resumeLoopGlobalClock(loop, 20_000)).toBe(false);
    expect(loop.globalPauseClock).toBeUndefined();
    expect(loopActiveElapsedMs(loop, 20_000)).toBe(20_000);
  });

  it('handles a pause at epoch zero, duplicate calls and multiple pause intervals', () => {
    const loop = state();
    expect(pauseLoopGlobalClock(loop, 0)).toBe(true);
    expect(pauseLoopGlobalClock(loop, 20_000)).toBe(false);
    expect(loopActiveElapsedMs(loop, 120_000)).toBe(0);
    expect(resumeLoopGlobalClock(loop, 120_000)).toBe(true);
    expect(resumeLoopGlobalClock(loop, 130_000)).toBe(false);
    expect(loopActiveElapsedMs(loop, 140_000)).toBe(20_000);
    pauseLoopGlobalClock(loop, 140_000);
    expect(loopActiveElapsedMs(loop, 340_000)).toBe(20_000);
    resumeLoopGlobalClock(loop, 340_000);
    expect(loopActiveElapsedMs(loop, 380_000)).toBe(60_000);
    expect(loop.startedAt).toBe(0);
  });

  it('freezes terminal elapsed time while a pause remains recorded', () => {
    const loop = state();
    pauseLoopGlobalClock(loop, 20_000);
    loop.endedAt = 140_000;
    expect(loopActiveElapsedMs(loop, 200_000)).toBe(20_000);
  });

  it('does not credit a negative pause duration after a clock moves backwards', () => {
    const loop = state();
    pauseLoopGlobalClock(loop, 20_000);
    resumeLoopGlobalClock(loop, 10_000);
    expect(loopActiveElapsedMs(loop, 30_000)).toBe(30_000);
    expect(loopActiveElapsedMs(loop, -1)).toBe(0);
  });
});
