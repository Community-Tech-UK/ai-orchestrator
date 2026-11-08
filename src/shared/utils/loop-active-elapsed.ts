/** The parts of a loop's state that its active running time depends on. */
interface LoopClockFields {
  startedAt: number;
  endedAt: number | null;
  globalPauseClock?: { pausedMs: number; pausedAt?: number };
}

/** Running time without time paused for a Harness restart; the wall-time cap and the progress bar share it. */
export function loopActiveElapsedMs(state: LoopClockFields, now = Date.now()): number {
  const end = state.endedAt ?? now;
  const clock = state.globalPauseClock;
  const currentPauseMs = clock?.pausedAt === undefined ? 0 : Math.max(0, end - clock.pausedAt);
  return Math.max(0, end - state.startedAt - (clock?.pausedMs ?? 0) - currentPauseMs);
}
