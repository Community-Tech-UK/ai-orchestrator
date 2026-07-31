/**
 * Shared "never worse" guard for context-reduction boundaries.
 *
 * Several places in the context pipeline replace a raw value (a full tool
 * output, an evidence preview swap, a truncated summary line) with a
 * "reduced" form that is *usually* cheaper in tokens but isn't guaranteed to
 * be — bounded evidence-preview markers carry citation overhead, and
 * truncating short strings can be a no-op. Swapping in a "reduced" value that
 * is actually the same size or larger wastes context budget for nothing.
 *
 * `pickNeverWorse` centralizes the comparison so every boundary applies the
 * same rule: keep whichever form costs fewer estimated tokens, and prefer the
 * reduced form on a tie (that's the whole point of computing it).
 */

import { estimateTokens } from '../../shared/utils/token-estimate';

/** A token-count function over a string. Defaults to the shared char heuristic. */
export type TokenEstimator = (text: string) => number;

const defaultEstimator: TokenEstimator = (text) => estimateTokens(text);

/**
 * Return whichever of `raw` or `reduced` is estimated to cost fewer tokens.
 * Ties go to `reduced`. Pass a custom `estimator` when the caller already has
 * a more precise per-boundary token count (e.g. a recorded `tokenCount` on an
 * evidence preview) rather than re-estimating from the string.
 */
export function pickNeverWorse(
  raw: string,
  reduced: string,
  estimator: TokenEstimator = defaultEstimator,
): string {
  return estimator(reduced) <= estimator(raw) ? reduced : raw;
}
