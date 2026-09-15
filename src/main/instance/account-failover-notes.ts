/**
 * Transcript notes for account-pool failover outcomes that did not simply
 * switch the session (spec §8.2). Pure, so the limit handler stays small.
 */

import type { AccountFailoverOutcome } from '../providers/account-pool/account-failover-coordinator';

export interface AccountFailoverNote {
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * @param parked whether the caller parked the session after a `not-switched` or `offered` outcome.
 * @returns null when the outcome needs no note (the switch re-sent the turn, or a duplicate report).
 */
export function accountFailoverNote(outcome: AccountFailoverOutcome, parked: boolean): AccountFailoverNote | null {
  if (outcome.outcome === 'already-moved') {
    // Never re-sent automatically: it could race the turn running on the new
    // account, or repeat a turn the user has since cancelled.
    return outcome.turnNotSent
      ? {
          content: 'This message was not sent because the session was moving to another account at the same time. Send it again.',
          metadata: { accountFailover: true, accountFailoverOutcome: 'turn-not-sent' },
        }
      : null;
  }
  if (outcome.outcome === 'offered') {
    // The pool moved to asking mid-switch: the offer notification went out, and the turn waits.
    return parked
      ? {
          content: 'Usage limit reached. Another account is available: switch accounts from the session header to continue now, or this session resumes when the limit lifts.',
          metadata: { providerLimitParked: true, accountFailover: true, accountFailoverOutcome: 'offered' },
        }
      : {
          content: 'Usage limit reached. Another account is available: switch accounts from the session header, then send your message again.',
          metadata: { accountFailover: true, accountFailoverOutcome: 'offered' },
        };
  }
  if (outcome.outcome !== 'not-switched') return null;
  if (parked) {
    return {
      content: outcome.reason === 'no-candidate'
        ? 'No other account in this pool is available, so this session is parked and will resume when the limit lifts.'
        : 'The session could not be moved to another account, so it is parked and will resume when the limit lifts.',
      metadata: { providerLimitParked: true, accountFailover: true, accountFailoverOutcome: outcome.reason },
    };
  }
  return {
    content: outcome.reason === 'no-candidate'
      ? 'Usage limit reached, and no other account in this pool is available right now.'
      : 'Usage limit reached. The session could not be moved to another account; send your message again once the limit resets.',
    metadata: { accountFailover: true, accountFailoverOutcome: outcome.reason },
  };
}
