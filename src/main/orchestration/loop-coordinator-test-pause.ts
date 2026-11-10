import { onTestFinished } from 'vitest';

/**
 * Test-only replacement for `loop-coordinator-utils`, for specs that drive a real LoopCoordinator.
 *
 * The coordinator pauses 1.5 s after every iteration (`loop-coordinator.ts`, the `sleep(1500)` at the end
 * of the iteration loop and after a branch-select adoption or plan regeneration). Specs that run a loop for
 * several iterations spent most of their time in that pause. This keeps every other wait as written: the
 * 250 ms admission poll and the breaker and transport backoffs must stay real, or the admission wait turns
 * into a busy loop. A spec opts in with:
 *
 *   vi.mock('./loop-coordinator-utils', async (importOriginal) =>
 *     (await import('./loop-coordinator-test-pause')).withShortIterationPause(await importOriginal()));
 */
export const LOOP_ITERATION_PAUSE_MS = 1500;
export const TEST_ITERATION_PAUSE_MS = 5;

let iterationPauseMs = TEST_ITERATION_PAUSE_MS;

export function withShortIterationPause<T extends { sleep: (ms: number) => Promise<void> }>(actual: T): T {
  return {
    ...actual,
    sleep: (ms: number) => actual.sleep(ms === LOOP_ITERATION_PAUSE_MS ? iterationPauseMs : ms),
  };
}

/**
 * Keep the real pause for the rest of the current test. For a test whose observations are timed against the
 * gap between iterations (it reads the state "after iteration N" while iteration N+1 has not started yet).
 */
export function useRealIterationPause(): void {
  iterationPauseMs = LOOP_ITERATION_PAUSE_MS;
  onTestFinished(() => { iterationPauseMs = TEST_ITERATION_PAUSE_MS; });
}
