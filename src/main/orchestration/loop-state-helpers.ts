/**
 * Small pure mutations over `LoopState`.
 *
 * These live outside `loop-coordinator.ts` because they depend on nothing but
 * the state object, and the coordinator sits at its LOC ceiling — adding a
 * four-line call to it pushed the file over, which is the signal to move
 * something out rather than to keep shaving comments.
 */

import type { LoopState } from '../../shared/types/loop.types';

/**
 * Clear the in-flight iteration, but only if it is still the one identified by
 * `seq`. The guard matters: a late cleanup from an abandoned attempt must not
 * clear the record of the attempt that replaced it.
 */
export function clearInFlightIteration(state: LoopState, seq: number): void {
  if (state.inFlightIteration?.seq === seq) {
    state.inFlightIteration = undefined;
  }
}
