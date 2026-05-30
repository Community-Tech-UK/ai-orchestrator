/**
 * Detecting provider *status* notices that masquerade as model output.
 *
 * A one-shot CLI call (title generation, verification synthesis, a consensus
 * vote) expects the model's answer back as the response `content`. But a
 * throttled or errored CLI does not throw — it prints a human-readable status
 * line as the "assistant" message and exits 0. The classic case is the Claude
 * rate-limit notice: "You've hit your session limit · resets 6:30pm". That text
 * is short and non-empty, so any consumer that trusts `response.content`
 * verbatim will treat the notice as a real answer (a tab title, a synthesized
 * verdict, a vote).
 *
 * {@link isProviderNotice} matches the distinctive *shape* of those notices
 * rather than a bare mention of "limit", so a genuine task ("Fix the
 * session-limit retry bug") is not caught. A false positive only costs the
 * affected one-shot its result — callers fall back to a safe default — so the
 * detector is intentionally biased toward catching notices.
 */

/** Patterns matching the distinctive shape of provider rate/usage-limit notices. */
export const PROVIDER_NOTICE_PATTERNS: readonly RegExp[] = [
  /you(?:'?ve|\s+have)\s+hit\s+your\s+\w+\s+limit/i, // "You've / You have hit your session limit"
  /\b(?:usage|session|rate|message)\s+limit\s+reached\b/i,
  /\b\d+\s*-?\s*hour\s+limit\s+reached\b/i,          // "5-hour limit reached"
  /\blimit\s*[·•∙‧]\s*resets?\b/i,                   // "limit · resets"
  /\bresets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/i, // "resets 6:30pm"
  /\b(?:too many requests|quota exceeded)\b/i,
];

/**
 * True when a one-shot response is a provider status/limit notice rather than a
 * usable model answer. Empty/whitespace input is not a notice (callers handle
 * emptiness separately).
 */
export function isProviderNotice(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_NOTICE_PATTERNS.some((re) => re.test(text));
}
