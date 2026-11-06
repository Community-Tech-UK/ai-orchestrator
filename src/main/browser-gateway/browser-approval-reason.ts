import { redactBrowserText } from './browser-redaction';

/** The tool arguments allow up to 1,000 characters; the person approving sees at most this many. */
export const MAX_STATED_REASON_LENGTH = 500;

/**
 * The agent's own words for why it is asking, cleaned for the approval card, or
 * undefined when it gave none.
 *
 * This only ever comes from the tool's `reason` argument: what the AGENT said.
 * It is never built from text read off the page, so a page cannot write the
 * reason a person reads. It is still free text from a model, so secrets are
 * redacted, characters that can disguise a sentence are dropped (direction
 * overrides, zero-width marks), whitespace collapses to single spaces and a
 * long one is cut.
 */
export function statedReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactBrowserText(value)
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_STATED_REASON_LENGTH
    ? `${text.slice(0, MAX_STATED_REASON_LENGTH - 1).trimEnd()}…`
    : text;
}
