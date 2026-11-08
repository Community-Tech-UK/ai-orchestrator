import type { LoopState } from '../../shared/types/loop.types';

/** Global restart pauses are excluded; the configured cap and chronology stay fixed. */
export function loopActiveElapsedMs(state: LoopState, now = Date.now()): number {
  const end = state.endedAt ?? now;
  const clock = state.globalPauseClock;
  const currentPauseMs = clock?.pausedAt === undefined ? 0 : Math.max(0, end - clock.pausedAt);
  return Math.max(0, end - state.startedAt - (clock?.pausedMs ?? 0) - currentPauseMs);
}

export function pauseLoopGlobalClock(state: LoopState, now = Date.now()): boolean {
  if (state.globalPauseClock?.pausedAt !== undefined) return false;
  state.globalPauseClock = { pausedMs: state.globalPauseClock?.pausedMs ?? 0, pausedAt: now };
  return true;
}

export function resumeLoopGlobalClock(state: LoopState, now = Date.now()): boolean {
  const clock = state.globalPauseClock;
  if (clock?.pausedAt === undefined) return false;
  state.globalPauseClock = { pausedMs: clock.pausedMs + Math.max(0, now - clock.pausedAt) };
  return true;
}
