import type { LoopState } from '../../shared/types/loop.types';

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
