import type { OutputMessage } from '../../shared/types/instance.types';
import { LEGACY_ACCOUNT_PROFILE_ID, isPooledProvider } from '../../shared/types/provider-account.types';
import type { ProviderId } from '../../shared/types/provider-quota.types';
import { getProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { reportUsageLimitHandling } from '../cli/usage-limit-dispatch';
import { buildUsageLimitNotice, type UsageLimitHandling } from '../cli/usage-limit-notice';
import { USAGE_LIMIT_WINDOW_KEY, findAnnouncedUsageLimit, type UsageLimitWindow } from '../cli/usage-limit-window';

export type SystemNoteSink = (instanceId: string, content: string, metadata: Record<string, unknown>) => void;

export interface UsageLimitAnnouncement {
  instanceId: string;
  provider: ProviderId;
  accountProfileId?: string | null;
  /** Epoch ms of a reset the provider or the quota record gave. Leave an assumed time out: none is invented. */
  resetAt?: number;
  /** The app's own reason for the stop. Details only. */
  reason: string;
  handling: UsageLimitHandling;
  /**
   * The conversation as it stands. When it already holds a note for this provider, account and window,
   * nothing more is said. Leave out for a writer that has no transcript to read.
   */
  transcript?: readonly OutputMessage[];
}

/** The account's own name, or nothing for the default account, an unpooled provider or an unreadable store. */
export function usageLimitAccountName(provider: string, profileId: string | null | undefined): string | undefined {
  if (!profileId || profileId === LEGACY_ACCOUNT_PROFILE_ID || !isPooledProvider(provider)) return undefined;
  try {
    return getProviderAccountStore().getProfile(provider, profileId)?.label;
  } catch {
    return undefined;
  }
}

/**
 * Says a usage limit in the transcript once. When an adapter is in the middle of announcing this very
 * event it is handed what was done and writes the one note itself; when the transcript already holds a
 * note for this window nothing is added; otherwise (a message held before it was sent, the first word
 * of a limit only the turn's error reported) the note is written here.
 */
export function announceUsageLimit(emit: SystemNoteSink | undefined, announcement: UsageLimitAnnouncement): void {
  if (reportUsageLimitHandling(announcement.provider, announcement.handling) || !emit) return;
  const notice = buildUsageLimitNotice({
    provider: announcement.provider,
    account: usageLimitAccountName(announcement.provider, announcement.accountProfileId),
    accountProfileId: announcement.accountProfileId,
    ...(announcement.resetAt !== undefined ? { resetAt: announcement.resetAt } : {}),
    rawDetail: announcement.reason,
    handling: announcement.handling,
  });
  if (announcement.transcript && findAnnouncedUsageLimit(announcement.transcript, notice.metadata[USAGE_LIMIT_WINDOW_KEY] as UsageLimitWindow)) return;
  emit(announcement.instanceId, notice.content, notice.metadata);
}
