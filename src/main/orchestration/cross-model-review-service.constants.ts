import {
  REMOTE_REVIEWER_PROVIDER_IDS,
  normalizeRemoteReviewerProvider,
} from '../../shared/types/reviewer-provider.types';

export const MIN_COOLDOWN_MS = 10_000;
export const MAX_REVIEW_HISTORY = 50;
export const RATE_LIMIT_CHECK_INTERVAL_MS = 30_000;
export const AVAILABILITY_REFRESH_INTERVAL_MS = 5 * 60_000;
export const SUPPORTED_REVIEWER_CLIS = new Set(REMOTE_REVIEWER_PROVIDER_IDS);
export const SUPPORTED_AGENTIC_REVIEWER_CLIS = new Set(REMOTE_REVIEWER_PROVIDER_IDS);

export function normalizeReviewerCli(cliType: string): string {
  return normalizeRemoteReviewerProvider(cliType);
}

function normalizeSupportedReviewerCliList(
  cliTypes: readonly string[],
  supportedClis: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawCliType of cliTypes) {
    const cliType = normalizeReviewerCli(rawCliType);
    if (!supportedClis.has(cliType) || seen.has(cliType)) {
      continue;
    }
    seen.add(cliType);
    normalized.push(cliType);
  }
  return normalized;
}

export function normalizeReviewerCliList(cliTypes: readonly string[]): string[] {
  return normalizeSupportedReviewerCliList(cliTypes, SUPPORTED_REVIEWER_CLIS);
}

export function normalizeAgenticReviewerCliList(cliTypes: readonly string[]): string[] {
  return normalizeSupportedReviewerCliList(cliTypes, SUPPORTED_AGENTIC_REVIEWER_CLIS);
}

/**
 * Does a reviewer error mean "rate-limited / out of quota" (cool down and retry
 * later) rather than "broken" (bench it)? Covers HTTP 429 and the varied prose
 * different CLIs emit: OpenAI "rate limit", Anthropic "quota", xAI/Grok Build
 * "usage limit" / "too many requests" / "resource exhausted", and subscription
 * caps ("limit reached / exceeded"). Grok Build's subscription cap in particular
 * does NOT surface as a 429, so plain string-matching on "429" missed it.
 */
export function isReviewerRateLimitError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('rate-limit') ||
    m.includes('ratelimit') ||
    m.includes('quota') ||
    m.includes('too many requests') ||
    m.includes('usage limit') ||
    m.includes('usage cap') ||
    m.includes('limit reached') ||
    m.includes('limit exceeded') ||
    m.includes('over capacity') ||
    m.includes('overloaded') ||
    m.includes('resource exhausted') ||
    m.includes('insufficient_quota')
  );
}
