/**
 * Fable WS11.3 — never-worse guard for content transforms.
 *
 * A "compression" (summary, extraction, rewrite-to-shrink) must never INFLATE
 * the content it replaces: local models happily return prose longer than the
 * input, and a summarizer that grows the payload silently defeats its purpose.
 * `pickSmaller` compares the original and the transformed text under an
 * injectable size estimator and returns whichever is smaller, flagging which
 * one won so callers can log/attribute the decision.
 */

export interface NeverWorseResult {
  content: string;
  /** Which candidate was returned. */
  picked: 'original' | 'transformed';
  originalSize: number;
  transformedSize: number;
}

/**
 * Return the smaller of the two texts under `estimator` (default: UTF-16
 * length). Ties keep the transformed text — an equal-size transform is
 * presumed to be the higher-signal rendering the caller asked for.
 */
export function pickSmaller(
  original: string,
  transformed: string,
  estimator: (text: string) => number = (text) => text.length,
): NeverWorseResult {
  const originalSize = estimator(original);
  const transformedSize = estimator(transformed);
  return transformedSize <= originalSize
    ? { content: transformed, picked: 'transformed', originalSize, transformedSize }
    : { content: original, picked: 'original', originalSize, transformedSize };
}
