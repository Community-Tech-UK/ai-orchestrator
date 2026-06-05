/**
 * Shared token-estimation primitive.
 *
 * This is the single, dependency-free heuristic entry point that replaces the
 * ~20 scattered ad-hoc `Math.ceil(text.length / 4)` implementations that used
 * to live in every context/memory/adapter module. Consolidating them here means
 * the heuristic can be improved in one place and every consumer benefits.
 *
 * Design constraints:
 * - **Pure & dependency-free.** No imports, so it is safe to import from the
 *   main process, the renderer, `src/shared`, and worker threads alike (a
 *   transitive `electron` import would crash workers — see the worker
 *   isolation rules in AGENTS.md).
 * - **Behaviour-preserving for Latin text.** When the input contains no CJK
 *   characters, `estimateTokens(text)` returns exactly `Math.ceil(text.length /
 *   4)` — byte-identical to every call site it replaces, so existing
 *   token-budget tests are unaffected.
 * - **Better for CJK.** CJK scripts tokenize far denser than ~4 chars/token;
 *   the old heuristic badly *under*-counted them (risking context overflow).
 *   When CJK characters are present they are counted at a denser ratio, which
 *   only ever makes the estimate larger (more conservative) — the safe
 *   direction for budget headroom.
 *
 * This is intentionally distinct from `TokenCounter` (`src/main/rlm/
 * token-counter.ts`), which is the heavier, model-calibrated, safety-margined
 * estimator used on the main process. Use `TokenCounter`/its `estimateTokens`
 * export when you have a model id and want the calibrated, padded count; use
 * this primitive for the lightweight provider-neutral char heuristic that the
 * shared and renderer layers (which cannot import main-process code) also need.
 */

/** Average characters per token for Latin/Western text — the long-standing default. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Tokens per CJK character. Han/Hiragana/Katakana/Hangul tokenize roughly
 * 1.3–2.5 characters per token across cl100k_base and the Claude tokenizer;
 * 0.6 tokens/char (~1.67 chars/token) is a conservative middle estimate.
 */
const CJK_TOKENS_PER_CHAR = 0.6;

/**
 * Match a single CJK character: CJK Unified Ideographs (+ Ext A and the common
 * compatibility blocks), Hiragana, Katakana, and Hangul syllables. The `u`
 * flag is required for the surrogate-pair-aware ranges to behave.
 */
const CJK_PATTERN =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

export interface TokenEstimateOptions {
  /**
   * Override the chars-per-token ratio used for non-CJK characters. Lower it
   * for dense structured content (JSON/code tokenizes slightly denser than
   * prose). Defaults to {@link DEFAULT_CHARS_PER_TOKEN} (4).
   */
  charsPerToken?: number;
}

/** Count characters that belong to a CJK script. */
function countCjkChars(text: string): number {
  const matches = text.match(CJK_PATTERN);
  return matches ? matches.length : 0;
}

/**
 * Estimate the token count of a string with a provider-neutral char heuristic.
 *
 * For Latin-only text this is exactly `Math.ceil(text.length / charsPerToken)`.
 * CJK characters are counted at a denser ratio so multi-byte scripts are not
 * under-counted.
 *
 * @param text - The text to estimate. Empty/falsy input returns 0.
 * @param options - Optional ratio overrides (e.g. for structured content).
 * @returns Estimated token count (always rounds up; >= 1 for non-empty input).
 */
export function estimateTokens(text: string, options?: TokenEstimateOptions): number {
  if (!text) return 0;

  const charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  const cjkChars = countCjkChars(text);
  if (cjkChars === 0) {
    // Fast path: identical to the legacy `Math.ceil(text.length / 4)` it replaces.
    return Math.ceil(text.length / charsPerToken);
  }

  const latinChars = text.length - cjkChars;
  const latinTokens = latinChars / charsPerToken;
  const cjkTokens = cjkChars * CJK_TOKENS_PER_CHAR;
  return Math.max(1, Math.ceil(latinTokens + cjkTokens));
}
