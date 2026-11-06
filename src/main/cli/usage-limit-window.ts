/**
 * Which refused window a usage-limit note speaks for, so a window is announced once.
 *
 * One refusal can reach the transcript from three places: the Claude adapter (from the provider's own
 * event), the limit handler (when it holds the session) and the turn-error path (when the turn then
 * fails). The first two share a single note through the hand-off in `usage-limit-dispatch.ts`. The
 * turn-error path runs later, on its own, so every note carries the window it speaks for and that path
 * reads the transcript: if a note for the same provider, account and window is already there, it stays
 * quiet. A window that has ended, or another account's window, is announced afresh.
 */

import type { OutputMessage } from '../../shared/types/instance.types';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';

export const USAGE_LIMIT_WINDOW_KEY = 'usageLimitWindow';

export interface UsageLimitWindow {
  provider: string;
  /** The account's profile id; `default` for the default account and for a provider without account pools. */
  account: string;
  /** The reset time the note told the user, epoch ms. Absent when the note could not name one. */
  resetAt?: number;
  /** When the note was written, epoch ms. */
  announcedAt: number;
}

/** A refusal is heard by each writer within moments; a note this fresh is the same refusal whatever reset each read. */
const SAME_REFUSAL_MS = 2 * 60_000;
/** How long a note with no reset time speaks for its window: the hour Harness benches an account for. */
const UNKNOWN_RESET_WINDOW_MS = 60 * 60_000;
/** The event, the error text and the quota record can name one window's reset minutes apart. */
const SAME_RESET_TOLERANCE_MS = 60 * 60_000;

export function usageLimitAccountKey(profileId: string | null | undefined): string {
  return profileId && profileId !== LEGACY_ACCOUNT_PROFILE_ID ? profileId : 'default';
}

export function usageLimitWindow(input: {
  provider: string;
  accountProfileId?: string | null;
  resetAt?: number;
  now: number;
}): UsageLimitWindow {
  return {
    provider: input.provider,
    account: usageLimitAccountKey(input.accountProfileId),
    ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
    announcedAt: input.now,
  };
}

/** The window a transcript message speaks for, or undefined for any other message (including a malformed tag). */
function windowOf(message: OutputMessage): UsageLimitWindow | undefined {
  const tag = message.metadata?.[USAGE_LIMIT_WINDOW_KEY];
  if (!tag || typeof tag !== 'object') return undefined;
  const { provider, account, resetAt, announcedAt } = tag as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof account !== 'string' || typeof announcedAt !== 'number') return undefined;
  return { provider, account, announcedAt, ...(typeof resetAt === 'number' ? { resetAt } : {}) };
}

function sameWindow(noted: UsageLimitWindow, event: UsageLimitWindow): boolean {
  if (noted.provider !== event.provider || noted.account !== event.account) return false;
  if (Math.abs(event.announcedAt - noted.announcedAt) <= SAME_REFUSAL_MS) return true;
  const until = noted.resetAt ?? noted.announcedAt + UNKNOWN_RESET_WINDOW_MS;
  if (event.announcedAt >= until) return false;
  return noted.resetAt === undefined || event.resetAt === undefined
    || Math.abs(noted.resetAt - event.resetAt) <= SAME_RESET_TOLERANCE_MS;
}

/** The note that already speaks for this refusal's window, when the transcript has one. */
export function findAnnouncedUsageLimit(transcript: readonly OutputMessage[], event: UsageLimitWindow): OutputMessage | undefined {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const noted = windowOf(transcript[index]);
    if (noted && sameWindow(noted, event)) return transcript[index];
  }
  return undefined;
}
