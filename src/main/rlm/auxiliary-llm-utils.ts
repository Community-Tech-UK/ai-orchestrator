// Ollama defaults num_ctx to a small value (~4k) and silently truncates longer
// prompts. We size the context window to fit the actual prompt + planned output
// so long-input slots aren't quietly chopped. Sizes are bucketed so the value is
// stable across similar calls; Ollama reloads the model whenever num_ctx changes.
const NUM_CTX_BUCKET = 8_192;
const NUM_CTX_MIN = 4_096;
const NUM_CTX_MAX_DEFAULT = 131_072;
const NUM_CTX_HEADROOM = 512;

/**
 * Pick an Ollama `num_ctx` that fits `promptTokens + outputTokens` plus template
 * headroom, rounded up to a stable bucket and clamped to sane bounds. The
 * ceiling is at least the slot's `maxInputTokens + outputTokens` budget so the
 * engine does not re-truncate prompts the slot was allowed to send.
 */
export function computeNumCtx(
  promptTokens: number,
  outputTokens: number,
  maxInputTokens: number,
): number {
  const desired = promptTokens + outputTokens + NUM_CTX_HEADROOM;
  const bucketed = Math.ceil(desired / NUM_CTX_BUCKET) * NUM_CTX_BUCKET;
  const ceiling = Math.max(NUM_CTX_MAX_DEFAULT, maxInputTokens + outputTokens + NUM_CTX_HEADROOM);
  return Math.min(Math.max(bucketed, NUM_CTX_MIN), ceiling);
}

/** Compact, stable `host:port` key for an endpoint URL (falls back to the raw value). */
export function hostKeyFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
