/**
 * Verify-output summarizer.
 *
 * When a loop's verify command (often `npm test`) FAILS, the coordinator stores
 * a raw, truncated `verifyOutputExcerpt`. This helper routes that output through
 * the auxiliary-LLM service's `verifyOutputSummary` slot to produce a terse,
 * human-readable root-cause TL;DR. It is purely additive operator UX:
 *
 *   - It NEVER influences the pass/fail / completion decision (the evidence
 *     resolver still reads only `verifyStatus`).
 *   - It is best-effort: returns null if auxiliary models are disabled, no local
 *     model is reachable, or anything goes wrong. The caller must treat null as
 *     "no summary" and keep the raw excerpt.
 *   - The slot defaults to `allowFrontierFallback: false`, so with no local model
 *     available it resolves to the empty-string fallback (→ null here) rather
 *     than spending frontier/cloud tokens.
 */

import { getLogger } from '../logging/logger';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';

const logger = getLogger('VerifyOutputSummarizer');

/** Verify output can be up to 200KB; failures cluster at the tail (vitest prints
 *  its failed-test summary last), so send the tail. The slot also caps input. */
const MAX_INPUT_CHARS = 16_000;

const SYSTEM_PROMPT =
  'You summarize failing test/verify command output for an engineer. In 1-4 short ' +
  'bullet points, give the most likely root cause(s) and the files/symbols to look ' +
  'at. Be terse. Do not restate full stack traces. If failures are unrelated, group them.';

export interface VerifyOutputSummary {
  text: string;
  /** 'local' | 'cheap-cloud' — never 'fallback' (those return null). */
  source: string;
  model?: string;
}

/**
 * Summarize failing verify/test output. Best-effort; returns null on any issue
 * (aux disabled, no local model, empty result, error). Never throws.
 */
export async function summarizeVerifyOutput(output: string): Promise<VerifyOutputSummary | null> {
  const trimmed = (output || '').trim();
  if (!trimmed) return null;

  // Prefer the tail — that's where the failure summary lives.
  const userPrompt =
    trimmed.length > MAX_INPUT_CHARS
      ? `(output truncated to last ${MAX_INPUT_CHARS} chars)\n\n${trimmed.slice(-MAX_INPUT_CHARS)}`
      : trimmed;

  try {
    const { text, decision } = await getAuxiliaryLlmService().generate(
      'verifyOutputSummary',
      SYSTEM_PROMPT,
      userPrompt,
    );
    if (decision.source === 'fallback' || !text.trim()) return null;
    return { text: text.trim(), source: decision.source, model: decision.model };
  } catch (err) {
    logger.debug('verify-output summary failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
