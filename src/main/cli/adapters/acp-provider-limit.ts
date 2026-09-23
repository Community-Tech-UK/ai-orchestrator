/**
 * Marks a failed ACP prompt as a provider limit so instance recovery can park
 * and resume it instead of erroring the session.
 *
 * OpenCode retries rate limits inside the session and says nothing over ACP
 * while it does; the failure only reaches the client once OpenCode gives up,
 * as a JSON-RPC error such as `Internal error: Rate Limited` or
 * `Internal error: Go usage limit reached. It will reset in 3 hours 20 minutes`
 * (retry texts from OpenCode's `session/retry.ts`). Those phrasings are not
 * limit *notices* in `isProviderNotice`'s sense, so they are tagged here with
 * the same `quota` diagnostics shape the provider-limit detector reads.
 */

/**
 * OpenCode's quota texts. "Provider is overloaded" (also in `retry.ts`) is left
 * out on purpose: an overload is the backend's capacity, not the user's quota,
 * so there is no reset to park until. It still classifies as retryable through
 * the shared `overloaded` pattern in `core/error-recovery.ts`.
 */
const LIMIT_PATTERNS: readonly RegExp[] = [
  /\brate[ -]?limited\b/i,
  /\brate increased too quickly\b/i,
  /\brate[ -]?limit(?:s|ed)? (?:reached|exceeded)\b/i,
  /\btoo many requests\b/i,
  /\busage limit reached\b/i,
  /\b(?:Free|Go)UsageLimitError\b/,
];

const RESET_IN = /\breset in (?:(\d+) days?)?\s*(?:(\d+) hours?)?\s*(?:(\d+) minutes?)?/i;

/** Epoch ms parsed from "reset in 1 day 2 hours" / "reset in 20 minutes", or undefined. */
export function parseAcpLimitResetIn(message: string, now: number): number | undefined {
  const match = RESET_IN.exec(message);
  if (!match) return undefined;
  const [days, hours, minutes] = [match[1], match[2], match[3]].map((part) => Number.parseInt(part ?? '0', 10));
  const totalMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
  return totalMs > 0 ? now + totalMs : undefined;
}

export function isAcpProviderLimitMessage(message: string): boolean {
  return LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Adds `quota` diagnostics to a prompt failure that reads as a provider limit. */
export function tagAcpProviderLimit(error: Error, now = Date.now()): Error {
  if (!isAcpProviderLimitMessage(error.message)) return error;
  const resetAt = parseAcpLimitResetIn(error.message, now);
  Object.assign(error, {
    quota: { exhausted: true, message: error.message.slice(0, 300), ...(resetAt ? { resetAt } : {}) },
  });
  return error;
}
