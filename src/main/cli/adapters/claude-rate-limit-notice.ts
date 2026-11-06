import type { CliRateLimitInfo } from '../../../shared/types/cli.types';
import {
  allowanceFromRateLimitType,
  buildUsageLimitNotice,
  buildUsageWarningNotice,
  namedAccount,
  type UsageLimitHandling,
} from '../usage-limit-notice';

const MAX_DETAIL_WORD_CHARS = 80;

/** A provider field as plain text for Details, whatever type it arrived as. */
function detailWord(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, MAX_DETAIL_WORD_CHARS) : fallback;
}

export interface ClaudeRateLimitNoticeInput {
  info: CliRateLimitInfo | null;
  /** The reset time the event gave, in epoch ms. */
  resetsAtMs: number | undefined;
  /** The account this adapter was started for, when it was started for a pooled one. */
  route: { profileId?: string; profileLabel?: string } | null;
  /** What the usage-overage stop reported doing about this very event, if it did anything. */
  handling: UsageLimitHandling | undefined;
  now?: number;
}

/**
 * The user's one note for a Claude `rate_limit_event` that is not the steady "allowed" state.
 * `rejected` means the account has used its allowance; any other throttled status (the CLI's
 * `allowed_warning`) is a heads-up. The runtime metadata the old note carried stays on the message.
 */
export function claudeRateLimitNotice(input: ClaudeRateLimitNoticeInput): { content: string; metadata: Record<string, unknown> } {
  const { info, resetsAtMs, handling } = input;
  const status = info?.status;
  const runtimeMetadata = { rateLimit: true, status, rateLimitType: info?.rateLimitType, resetsAt: resetsAtMs };
  const resets = resetsAtMs !== undefined ? new Date(resetsAtMs).toLocaleTimeString() : 'unknown';
  const noticeInput = {
    provider: 'claude',
    account: namedAccount(input.route?.profileId, input.route?.profileLabel),
    accountProfileId: input.route?.profileId,
    allowance: allowanceFromRateLimitType(info?.rateLimitType),
    ...(resetsAtMs !== undefined ? { resetAt: resetsAtMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    rawDetail: `Provider rate limit "${detailWord(status, 'unknown')}" (${detailWord(info?.rateLimitType, 'window')}). Resets at ${resets}.`,
  };
  if (status !== 'rejected') return { content: buildUsageWarningNotice(noticeInput), metadata: runtimeMetadata };
  const notice = buildUsageLimitNotice({ ...noticeInput, ...(handling ? { handling } : {}) });
  return { content: notice.content, metadata: { ...runtimeMetadata, ...notice.metadata } };
}
