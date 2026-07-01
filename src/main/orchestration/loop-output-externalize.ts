/**
 * LF-1 (loopfixex.md) — tool-result clearing for the loop.
 *
 * Everything the loop *retains* is already bounded (activity messages are
 * truncated to 280 chars; the stored iteration output is excerpted to ~2KB).
 * The one genuinely unbounded value is the FULL `result.response` a chatty
 * iteration produces (it can dump large tool outputs into its text, reaching
 * many MB). When `context.compaction.clearToolResults` is enabled, this offloads
 * an oversized full response to the shared output cache (retrievable later) and
 * returns a compact head+tail preview + retrieval marker — the "safest,
 * lightest-touch compaction" (Anthropic) for the loop's retained output.
 *
 * Kept in its own module (only depends on the logger; lazy-requires the
 * persistence manager) so it's unit-testable without the invoker's heavy deps.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('LoopOutputExternalize');

/**
 * Outputs at/under this size are kept verbatim; larger ones are offloaded when
 * `clearToolResults` is on. Matches the OutputPersistenceManager default so
 * behaviour is consistent across the app.
 */
export const LOOP_OUTPUT_EXTERNALIZE_THRESHOLD = 50_000;

export interface LoopOutputExternalizeOptions {
  delegateInspectionHint?: boolean;
}

/** Offloads `(toolName, output)` to a cache and returns a compact preview. */
export type OutputExternalizer = (
  toolName: string,
  output: string,
  options?: LoopOutputExternalizeOptions,
) => Promise<string>;

/**
 * Production externalizer — the shared OutputPersistenceManager. Lazy-required
 * so test/headless paths (and the disabled/small-output fast path) never pull
 * in the persistence stack. Returns null when unavailable.
 */
function defaultExternalizer(): OutputExternalizer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOutputPersistenceManager } = require('../context/output-persistence') as typeof import('../context/output-persistence');
    const manager = getOutputPersistenceManager();
    return (toolName, output, options) => manager.maybeExternalize(toolName, output, options);
  } catch {
    return null;
  }
}

/**
 * When `enabled` and `output` exceeds the threshold, offload the full text via
 * `externalize` (defaults to the shared OutputPersistenceManager) and return a
 * compact preview; otherwise return `output` unchanged. `externalize` is
 * injectable for testing. Any failure degrades to the original text (never
 * blocks the loop).
 */
export async function maybeExternalizeLoopOutput(
  output: string,
  enabled: boolean,
  externalizeOrOptions?: OutputExternalizer | LoopOutputExternalizeOptions,
  maybeOptions?: LoopOutputExternalizeOptions,
): Promise<string> {
  if (!enabled || output.length <= LOOP_OUTPUT_EXTERNALIZE_THRESHOLD) return output;
  const externalize = typeof externalizeOrOptions === 'function' ? externalizeOrOptions : undefined;
  const options = typeof externalizeOrOptions === 'function' ? maybeOptions : externalizeOrOptions;
  const fn = externalize ?? defaultExternalizer();
  if (!fn) return output;
  try {
    return await fn('loop-iteration-output', output, options);
  } catch (err) {
    logger.warn('LF-1 output externalization failed; keeping full output', {
      error: err instanceof Error ? err.message : String(err),
    });
    return output;
  }
}
