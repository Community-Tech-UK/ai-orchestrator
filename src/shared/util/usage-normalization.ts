/**
 * usage-normalization.ts
 *
 * Token usage normalization utility that handles 15+ provider naming conventions
 * for input/output/cache token fields. Inspired by openclaw's normalization pattern.
 *
 * Supports field names from:
 *   - Anthropic SDK (camelCase and snake_case)
 *   - OpenAI / Azure OpenAI
 *   - Canonical / internal representation
 *   - Various cache token naming conventions
 *
 * ## Contract (locked by usage-normalization.spec.ts)
 *   - **Precedence:** for each canonical field the aliases are resolved by a
 *     `??` chain, so the first *defined* (non-null/undefined) value wins —
 *     canonical → camelCase → snake_case. A `null`/`undefined` alias falls
 *     through to the next; a present-but-*invalid* higher-precedence value does
 *     NOT (it is dropped, not back-filled) — conservative by design.
 *   - **Validity:** a resolved value is kept only if it is a finite,
 *     non-negative number (see {@link asFiniteNumber}); `0` is valid. NaN,
 *     ±Infinity, negatives, and non-numbers are dropped per-field.
 *   - **Emptiness:** the result contains only the fields that resolved to a
 *     valid value; if none did, the function returns `undefined` (never an
 *     empty object) so callers can treat "no usage" as a single falsy case.
 */

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

/**
 * Normalized token usage with canonical field names.
 * All fields are optional — callers should treat absent fields as zero where
 * a numeric value is required.
 */
export interface NormalizedUsage {
  /** Tokens consumed by the prompt / user input. */
  input?: number;
  /** Tokens generated in the model response. */
  output?: number;
  /** Tokens read from the prompt cache (already paid for in a prior call). */
  cacheRead?: number;
  /** Tokens written to the prompt cache (charged at a higher rate). */
  cacheWrite?: number;
  /** Pre-computed total, if the provider surfaced one. */
  total?: number;
}

/**
 * Loose input type that accepts any of the known provider field naming
 * conventions. Unknown extra fields are allowed via the index signature.
 */
export interface UsageLike {
  // ---- Canonical (matches NormalizedUsage) --------------------------------
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;

  // ---- Anthropic SDK camelCase --------------------------------------------
  inputTokens?: number;
  outputTokens?: number;

  // ---- OpenAI style -------------------------------------------------------
  promptTokens?: number;
  completionTokens?: number;

  // ---- Snake_case variants ------------------------------------------------
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;

  // ---- Alternate totals ---------------------------------------------------
  totalTokens?: number;
  total_tokens?: number;

  // ---- Cache variants -----------------------------------------------------
  cache_read?: number;
  cache_write?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;

  // ---- Escape hatch for future / unknown fields ---------------------------
  [key: string]: number | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `v` when it is a finite, non-negative number; otherwise `undefined`.
 *
 * Rejects: NaN, ±Infinity, negative numbers, and non-number types.
 */
function asFiniteNumber(v: number | undefined): number | undefined {
  if (typeof v !== 'number') return undefined;
  if (!Number.isFinite(v)) return undefined;
  if (v < 0) return undefined;
  return v;
}

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw provider usage object into a canonical `NormalizedUsage`
 * shape, resolving 15+ naming conventions via `??` coalescing chains.
 *
 * @param usage - Raw usage object from any supported provider, or null/undefined.
 * @returns A `NormalizedUsage` object containing only the fields that resolved
 *   to valid finite non-negative numbers, or `undefined` if no valid fields
 *   were found at all.
 *
 * @example
 * // Anthropic SDK response
 * normalizeUsage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 });
 * // => { input: 100, output: 50, cacheRead: 20 }
 *
 * @example
 * // OpenAI response
 * normalizeUsage({ prompt_tokens: 200, completion_tokens: 80 });
 * // => { input: 200, output: 80 }
 */
export function normalizeUsage(usage: UsageLike | null | undefined): NormalizedUsage | undefined {
  if (usage == null) return undefined;

  const input = asFiniteNumber(
    usage.input ??
    usage.inputTokens ??
    usage.input_tokens ??
    usage.promptTokens ??
    usage.prompt_tokens
  );

  const output = asFiniteNumber(
    usage.output ??
    usage.outputTokens ??
    usage.output_tokens ??
    usage.completionTokens ??
    usage.completion_tokens
  );

  const cacheRead = asFiniteNumber(
    usage.cacheRead ??
    usage.cache_read ??
    usage.cacheReadTokens ??
    usage.cache_read_tokens ??
    usage.cache_read_input_tokens
  );

  const cacheWrite = asFiniteNumber(
    usage.cacheWrite ??
    usage.cache_write ??
    usage.cacheWriteTokens ??
    usage.cache_write_tokens ??
    usage.cache_creation_input_tokens
  );

  const total = asFiniteNumber(
    usage.total ??
    usage.totalTokens ??
    usage.total_tokens
  );

  // Return undefined (not an empty object) when nothing resolved.
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  const normalized: NormalizedUsage = {};
  if (input !== undefined) normalized.input = input;
  if (output !== undefined) normalized.output = output;
  if (cacheRead !== undefined) normalized.cacheRead = cacheRead;
  if (cacheWrite !== undefined) normalized.cacheWrite = cacheWrite;
  if (total !== undefined) normalized.total = total;

  return normalized;
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

/**
 * Derives the total number of prompt-side tokens by summing input, cache-read,
 * and cache-write tokens. Absent fields are treated as zero.
 *
 * This reflects the full prompt cost: the model must process input tokens
 * regardless of whether they came from cache or fresh encoding.
 *
 * @param usage - A normalized usage object.
 * @returns Total prompt token count (always >= 0).
 */
export function derivePromptTokens(usage: NormalizedUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * Derives the total session token count by adding output tokens to the prompt
 * token count. Absent fields are treated as zero.
 *
 * Does NOT clamp to any context window size — the caller is responsible for
 * any window-limit enforcement.
 *
 * @param usage - A normalized usage object.
 * @returns Total session token count (always >= 0).
 */
export function deriveSessionTotalTokens(usage: NormalizedUsage): number {
  return derivePromptTokens(usage) + (usage.output ?? 0);
}
