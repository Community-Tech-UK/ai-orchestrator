/**
 * The one sentence a person reads when a provider account runs out of allowance.
 *
 * It used to be two notes: the Claude adapter's `Provider rate limit "rejected"
 * (seven_day). Resets at 11:00:00 PM.` and the limit handler's `Provider limit
 * reached. This session is parked…`. Both are built here now, from the shared
 * presenter, so they cannot drift apart. Provider words (`rejected`,
 * `seven_day`) are evidence for Details; only the account's name, the kind of
 * allowance and the reset time reach a sentence.
 */

import { accountFamilyName } from '../../shared/display-names';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';
import { presentError, type PresentedError } from '../../shared/present-error';
import { USAGE_LIMIT_WINDOW_KEY, usageLimitWindow } from './usage-limit-window';

export type UsageAllowance = 'weekly' | 'daily' | 'session';

/** What Harness did about the limit, reported by whoever did it. */
export type UsageLimitHandling =
  | { kind: 'switching'; metadata: Record<string, unknown> }
  | { kind: 'parked'; autoResume: boolean; heldMessage: boolean; metadata: Record<string, unknown> };

export interface UsageLimitNoticeInput {
  /** Provider id; the presenter shows an unknown id as plain "AI". */
  provider: string;
  /** The account's own name for itself. Leave out for the default account. */
  account?: string | null;
  /** The account's profile id, which tells one account's window from another's. Leave out for the default account. */
  accountProfileId?: string | null;
  allowance?: UsageAllowance;
  /** Epoch ms the provider (or the quota record) gave. Leave out when unknown: nothing is invented. */
  resetAt?: number;
  now?: number;
  /** The provider's or the app's own words. Details only, never a sentence. */
  rawDetail: string;
  handling?: UsageLimitHandling;
}

const MAX_ACCOUNT_NAME_CHARS = 40;
const MAX_RAW_DETAIL_CHARS = 500;

/** Claude names its windows (`five_hour`, `seven_day_opus`…); only the kind of allowance is kept. */
export function allowanceFromRateLimitType(type: unknown): UsageAllowance | undefined {
  if (typeof type !== 'string') return undefined;
  if (type === 'five_hour') return 'session';
  return type.startsWith('seven_day') ? 'weekly' : undefined;
}

/** The default ("legacy") account has no name worth printing; a named one keeps its label. */
export function namedAccount(profileId: string | null | undefined, label: string | null | undefined): string | undefined {
  return profileId && profileId !== LEGACY_ACCOUNT_PROFILE_ID ? label ?? undefined : undefined;
}

/**
 * A label fit to sit inside "Your <label> Claude account": no control characters, and no
 * repeat of the provider's name or the word "account" ("Claude Max" reads "Max").
 */
export function cleanAccountLabel(label: string | null | undefined, providerDisplayName: string): string | undefined {
  if (typeof label !== 'string') return undefined;
  const provider = providerDisplayName.toLowerCase();
  const words = label.replace(/\p{Cc}/gu, ' ').split(/\s+/)
    .filter(word => word && word.toLowerCase() !== provider && word.toLowerCase() !== 'account');
  return words.join(' ').slice(0, MAX_ACCOUNT_NAME_CHARS).trim() || undefined;
}

function futureReset(resetAt: number | undefined, now: number): number | undefined {
  return typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > now ? resetAt : undefined;
}

function parkedSentence(handling: Extract<UsageLimitHandling, { kind: 'parked' }>): string {
  if (handling.autoResume) {
    return handling.heldMessage
      ? 'Your message will be sent again automatically once the allowance resets.'
      : 'Harness will pick this session up again once the allowance resets.';
  }
  return handling.heldMessage
    ? 'Your message was not sent. Press Resume, or send it again once the allowance resets.'
    : 'This session is on hold until the allowance resets.';
}

function quotaPresentation(input: UsageLimitNoticeInput, now: number, resetAt: number | undefined): PresentedError {
  // The label sits inside "Your <label> <account family> account", so it is cleaned of that family's name.
  const account = cleanAccountLabel(input.account, accountFamilyName(input.provider));
  return presentError(
    { code: 'quota', message: input.rawDetail.slice(0, MAX_RAW_DETAIL_CHARS) },
    {
      provider: input.provider,
      now,
      ...(account ? { account } : {}),
      ...(input.allowance ? { allowance: input.allowance } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    },
  );
}

export interface UsageLimitNotice {
  content: string;
  presentation: PresentedError;
  /**
   * What the message carries beside its words: what Harness did about the limit, the presentation (the
   * provider's own words live in its Details) and the window the message speaks for (see usage-limit-window.ts).
   */
  metadata: Record<string, unknown>;
}

/** The message for an account that has used its allowance. */
export function buildUsageLimitNotice(input: UsageLimitNoticeInput): UsageLimitNotice {
  const now = input.now ?? Date.now();
  const resetAt = futureReset(input.resetAt, now);
  const stated = quotaPresentation(input, now, resetAt);
  const presentation: PresentedError = input.handling?.kind === 'switching'
    ? { category: stated.category, headline: stated.headline, rawDetail: stated.rawDetail,
      whatToDo: 'No action needed: Harness is moving this conversation to another account.' }
    : stated;
  const outcome = input.handling?.kind === 'parked' ? parkedSentence(input.handling) : '';
  return {
    content: [presentation.headline, presentation.whatToDo, outcome].filter(Boolean).join(' '),
    presentation,
    metadata: {
      ...input.handling?.metadata,
      errorPresentation: presentation,
      [USAGE_LIMIT_WINDOW_KEY]: usageLimitWindow({ provider: input.provider, accountProfileId: input.accountProfileId, resetAt, now }),
    },
  };
}

/** The calm heads-up for an account that is close to, but not at, its allowance. */
export function buildUsageWarningNotice(input: Omit<UsageLimitNoticeInput, 'handling'>): string {
  const now = input.now ?? Date.now();
  const { headline } = quotaPresentation(input, now, futureReset(input.resetAt, now));
  return `${headline.replace(' has used its ', ' is close to its ')} No action needed: you can keep working.`;
}
