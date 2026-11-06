/**
 * Timing for specs that end a turn after changing files.
 *
 * A file or folder stamped within `BOUNDARY_UNCERTAINTY_MS` of the moment a turn ends
 * cannot be told from an edit made just after it, so the turn gets no count. A real agent's
 * last write comes well before its reply is finished; a spec that writes a file and ends
 * the turn in the same breath has to wait out the margin to stand in for that.
 */

import { BOUNDARY_UNCERTAINTY_MS } from './turn-snapshot-git';

/** Resolves once everything written so far is clear of the uncertainty margin. */
export function letFileTimesClearBoundary(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, BOUNDARY_UNCERTAINTY_MS + 25));
}
