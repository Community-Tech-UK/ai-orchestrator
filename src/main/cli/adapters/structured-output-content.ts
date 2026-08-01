/**
 * Structured-output extraction for Claude one-shots (LT-025).
 *
 * When the CLI is spawned with `--json-schema`, it does **not** return the
 * schema-conformant object as assistant text. It emits a tool call named
 * `StructuredOutput` whose `input` *is* the object:
 *
 * ```json
 * {"type":"assistant","message":{"content":[
 *   {"type":"tool_use","name":"StructuredOutput","input":{ …the verdict… }}]}}
 * ```
 *
 * The adapter's parser routes text blocks to `content` and tool_use blocks to
 * `toolCalls`, so a reply that is *only* a structured answer — exactly what
 * `--json-schema` asks for — produced `content: ''`. Every cross-model review
 * with a Claude reviewer therefore saw a zero-length response, burned its one
 * format-repair retry on a second empty answer, and failed.
 */

/** The tool name the CLI uses to deliver `--json-schema` output. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * Serialize a structured payload as the response content.
 *
 * Returns `null` (not `''`) when there is nothing usable, so the caller can
 * fall back to the turn's text content.
 *
 * An empty object is treated as nothing usable. That is correct for both review
 * schemas, whose fields are all `required`, so `{}` can never be a valid final
 * answer — but it would need revisiting for an all-optional schema, where `{}`
 * is legitimate and this would resurface the LT-025 symptom.
 */
export function serializeStructuredOutput(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    return null;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    // A payload that cannot be serialized is not usable as a response; let the
    // caller fall back to whatever text the turn produced.
    return null;
  }
}

/** One `tool_use` block as it appears on an assistant message. */
export interface StructuredOutputCandidate {
  name?: string;
  input?: Record<string, unknown>;
  /** Set when the block came from a subagent turn rather than the main one. */
  parentToolUseId?: string | null;
}

/**
 * Pick the payload that is actually the answer.
 *
 * Two things matter here, and both were found by review rather than by the
 * original fix:
 *
 * 1. **Take the LAST call, not the first.** The CLI validates each
 *    `StructuredOutput` call and, on a schema mismatch, returns an error
 *    tool_result and lets the model retry — so a single turn can contain a
 *    *rejected* payload followed by the accepted one. Strict API-level
 *    enforcement is unavailable for these schemas (the CLI's strict-conversion
 *    allowlist has no `minimum`/`maxLength`/`maxItems`, so it falls back to
 *    non-strict), which makes the retry path reachable in practice, not
 *    theoretical. Taking the first call hands back the payload the CLI already
 *    rejected.
 * 2. **Ignore subagent blocks.** Subagent assistant messages are streamed into
 *    the same top-level NDJSON, tagged with `parent_tool_use_id`. A subagent
 *    forced to call `StructuredOutput` would otherwise overwrite the parent
 *    turn's real answer.
 */
export function pickStructuredOutputPayload(
  candidates: readonly StructuredOutputCandidate[],
): Record<string, unknown> | undefined {
  let picked: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    if (candidate.name !== STRUCTURED_OUTPUT_TOOL) continue;
    if (candidate.parentToolUseId) continue;
    if (candidate.input && Object.keys(candidate.input).length > 0) {
      picked = candidate.input;
    }
  }
  return picked;
}

/** Convenience: pick the answer payload and serialize it, or `null`. */
export function structuredOutputContent(
  candidates: readonly StructuredOutputCandidate[],
): string | null {
  return serializeStructuredOutput(pickStructuredOutputPayload(candidates));
}
