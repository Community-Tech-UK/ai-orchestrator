/**
 * Provider-limit classification for a session's FINAL assistant output.
 *
 * Shared by AutomationRunner and the Plan Queue, so it lives outside both
 * (moved here from automations/automation-run-provider-limit.ts, which now
 * re-exports it). The automation-specific consequences below still apply there.
 *
 * A throttled provider CLI does not fail: it prints a status notice ("You've
 * hit your monthly spend limit · ... resets 11pm") as its final assistant
 * message and exits 0. Without this check the runner stored that notice as
 * the output of a `succeeded` run.
 *
 * Classification keys on the run's FINAL assistant output only, so a notice
 * that appears mid-run and is followed by real work still succeeds. Failing a
 * run is costlier than dropping a one-shot answer, and automation reports
 * often talk about third-party limits ("LinkedIn message limit reached",
 * "Google Ads spend limit hit"). So this classifier is deliberately narrower
 * than the shared isProviderNotice(): the output must be short and the WHOLE
 * message must be a provider notice (optionally after ⚠, ■, > or an error
 * label), with only that notice's own reset, upgrade or retry continuation. The shared patterns in
 * cli/provider-notice.ts are left untouched because park detection, Codex
 * recovery and loop parking depend on them.
 *
 * Consequences of a `provider_limit:` error, enforced elsewhere:
 * - no automatic retry (automation-runner-terminal.ts); the next scheduled
 *   fire is the recovery, and any opt-in session park-resume is unaffected;
 * - no growth of the consecutive-failure streak and no auto-disable
 *   (automation-store-outcome-ops.ts); last_failure_at/reason are still set.
 */

export const PROVIDER_LIMIT_ERROR_PREFIX = 'provider_limit:';

/** Real provider notices are one line; a final report longer than this is not a notice. */
export const MAX_PROVIDER_NOTICE_LENGTH = 500;

const MAX_ERROR_NOTICE_CHARS = 240;

// Building blocks. Every notice regex is anchored at both ends of the trimmed
// message, so the WHOLE final output must be the notice: a digest quoting one,
// a notice from another service, or a notice followed by more report lines
// never fails a run.

/** Optional CLI lead-in: ⚠ / ■ / > and "Error:", "API Error:" or "stream error:". */
const LEAD_IN = String.raw`^(?:(?:⚠\p{Mn}?|■|>)\s*)?(?:(?:api\s+error|stream\s+error|error):\s*)?`;
/** The same, but an error label is required (used for a bare "You've hit your usage limit."). */
const ERROR_LEAD_IN = String.raw`^(?:(?:⚠\p{Mn}?|■|>)\s*)?(?:api\s+error|stream\s+error|error):\s*`;

const SEP = String.raw`\s*[·∙•‧]\s*`;
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?|\d{1,2}:\d{2})`;
const WEEKDAY = String.raw`(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?\b`;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const DATE = String.raw`(?:${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}(?:\s+\d{4})?)`;
const ISO = String.raw`\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?`;
const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)`;
const RELATIVE = String.raw`in\s+\d+\s*${UNIT}(?:,?\s+(?:and\s+)?\d+\s*${UNIT})?`;
/** A time or date: "3am", "Monday", "Sep 20 at 5pm", "in 2 hours", an ISO timestamp. */
const WHEN = String.raw`(?:${ISO}|${RELATIVE}|(?:today|tomorrow)(?:\s+at)?\s+${CLOCK}|(?:${WEEKDAY}|${DATE})(?:,?\s+(?:at\s+)?${CLOCK})?|${CLOCK}(?:\s+(?:on\s+)?(?:${WEEKDAY}|${DATE}))?)`;
// Bracketed suffix after a reset time. This is the ONLY capturing group in the notice regexes;
// classifyFinalOutputProviderLimit checks each captured value against the case-sensitive
// TIMEZONE_TEXT_RE, so "(LinkedIn)" or "(Explee)" never passes as a timezone. (The notice
// regexes are case-insensitive, so this check cannot live inside them without inline modifiers.)
const TIMEZONE = String.raw`(?:\s*\(([^()\n]{1,40})\))?`;
/** IANA "Europe/London", "UTC" / "GMT+01:00", or an abbreviation such as "BST". Case-sensitive on purpose. */
const TIMEZONE_TEXT_RE = /^(?:[A-Z][A-Za-z]+(?:\/[A-Z][A-Za-z0-9_+-]*){1,2}|(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?|[A-Z]{2,5})$/u;
const RESETS_WHEN = String.raw`resets?\s+(?:at\s+)?${WHEN}${TIMEZONE}\.?`;

/** "· resets 11pm (Europe/London)" and nothing after it. */
const RESET_TAIL = String.raw`${SEP}${RESETS_WHEN}`;
const PROVIDER_HOST_URL = String.raw`(?:https?:\/\/)?(?:[\w-]+\.)*(?:claude\.ai|anthropic\.com|chatgpt\.com|openai\.com)\/\S*`;
const LIMIT_WORD = String.raw`(?:session|usage|weekly|monthly|spend|opus|sonnet|\d+\s*-?\s*hour)`;
/** Claude spend limit: "· raise it at claude.ai/settings/usage?... · your weekly limit resets 11pm (Europe/London)". */
const RAISE_TAIL = String.raw`${SEP}raise\s+it\s+at\s+${PROVIDER_HOST_URL}(?:${SEP}your\s+${LIMIT_WORD}\s+limit\s+${RESETS_WHEN})?`;
const TRY_AGAIN = String.raw`try\s+again\s+(?:${RELATIVE}|at\s+${WHEN}${TIMEZONE}|later)`;
const VISIT = String.raw`visit\s+${PROVIDER_HOST_URL}(?:\s+to\s+purchase\s+more\s+credits)?`;
const UPGRADE = String.raw`upgrade\s+to\s+(?:pro|plus|max|team)(?:\s*\(${PROVIDER_HOST_URL}\))?`;
/** Codex: ". Visit …/settings/usage …", ". Upgrade to Pro (…), visit … or try again in 3 days.", ". Try again later." */
const CODEX_TAIL = String.raw`\.\s*(?:(?:${UPGRADE}(?:,?\s*${VISIT})?|${VISIT})(?:,?\s+or\s+${TRY_AGAIN})?|${TRY_AGAIN}(?:,?\s*(?:or\s+)?${UPGRADE})?)\.?`;

const HIT_YOUR_LIMIT = String.raw`you(?:['’]?ve|\s+have)\s+hit\s+your\s+(?:${LIMIT_WORD}(?:\s+(?:spend|usage))?\s+)?limit`;
const LIMIT_REACHED = String.raw`(?:usage|session|weekly|opus|sonnet|\d+\s*-?\s*hour)\s+limit\s+reached`;
const PROVIDER_PREFIX = String.raw`(?:claude(?:\s+ai)?|codex|chatgpt|copilot)\s+`;
const TIMESTAMP_TAIL = String.raw`\|\d{9,}`;
const WILL_RESET_TAIL = String.raw`\.\s*your\s+limit\s+will\s+reset\s+(?:at\s+)?${WHEN}${TIMEZONE}\.?`;
const END = String.raw`\s*$`;

const PROVIDER_LIMIT_NOTICE_RES: readonly RegExp[] = [
  // (a)/(e) "You've hit your session limit · resets 6:30pm", "You've hit your limit · resets 11pm",
  // the Claude monthly spend message, and Codex ". Visit … / Upgrade to Pro … / try again …".
  new RegExp(`${LEAD_IN}${HIT_YOUR_LIMIT}(?:${RESET_TAIL}|${RAISE_TAIL}|${CODEX_TAIL})${END}`, 'iu'),
  // "stream error: You've hit your usage limit." needs the error label to stand on its own.
  new RegExp(`${ERROR_LEAD_IN}${HIT_YOUR_LIMIT}\\.?${END}`, 'iu'),
  // (b) provider-prefixed: "Claude usage limit reached.", "Claude AI usage limit reached|1757800000",
  // "Claude usage limit reached. Your limit will reset at 7pm (Europe/London)."
  new RegExp(`${LEAD_IN}${PROVIDER_PREFIX}${LIMIT_REACHED}(?:\\.?|${RESET_TAIL}|${TIMESTAMP_TAIL}|${WILL_RESET_TAIL})${END}`, 'iu'),
  // (b) unprefixed needs a reset or timestamp: "5-hour limit reached ∙ resets 3am", "Opus limit reached ∙ resets 3am".
  new RegExp(`${LEAD_IN}${LIMIT_REACHED}(?:${RESET_TAIL}|${TIMESTAMP_TAIL}|${WILL_RESET_TAIL})${END}`, 'iu'),
  // (c) "You've reached your usage limit."
  new RegExp(`${LEAD_IN}you(?:['’]?ve|\\s+have)\\s+reached\\s+your\\s+usage\\s+limit(?:\\.?|${RESET_TAIL}|${CODEX_TAIL})${END}`, 'iu'),
  // (d) Copilot "Error: You have exceeded your monthly quota (Request ID: ...)".
  new RegExp(`${LEAD_IN}you\\s+have\\s+exceeded\\s+your\\s+(?:weekly|monthly)\\s+quota(?:\\s*\\(request\\s+id:[^()\\n]*\\))?\\.?${END}`, 'iu'),
];

/**
 * Returns the run `error` to record when the final assistant output is a
 * provider limit notice, or null when the output is a genuine result.
 */
export function classifyFinalOutputProviderLimit(finalOutput: string | undefined): string | null {
  const trimmed = finalOutput?.trim();
  if (
    !trimmed
    || trimmed.length > MAX_PROVIDER_NOTICE_LENGTH
    || !PROVIDER_LIMIT_NOTICE_RES.some((notice) => matchesWithTimezoneSuffix(notice, trimmed))
  ) {
    return null;
  }
  return `${PROVIDER_LIMIT_ERROR_PREFIX} ${sanitiseNotice(trimmed)}`;
}

function matchesWithTimezoneSuffix(notice: RegExp, text: string): boolean {
  const match = notice.exec(text);
  return match !== null && match.slice(1).every((suffix) => suffix === undefined || TIMEZONE_TEXT_RE.test(suffix));
}

export function isProviderLimitRunError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(PROVIDER_LIMIT_ERROR_PREFIX);
}

function sanitiseNotice(text: string): string {
  const collapsed = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ERROR_NOTICE_CHARS
    ? `${collapsed.slice(0, MAX_ERROR_NOTICE_CHARS - 3)}...`
    : collapsed;
}
