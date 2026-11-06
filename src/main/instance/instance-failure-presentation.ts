/**
 * The words a person reads when a session fails to start or a turn fails, and the real reason behind them.
 *
 * Both used to put the provider's or the app's own text on the screen (`This session could not start.
 * Reason: spawn ENOENT`, `Error: stream disconnected before completion`). The sentence is built here from
 * the shared presenter, and the real reason, cleaned of secrets, rides on the message as
 * `errorPresentation.rawDetail`, which the transcript shows under Details. Programs that need the real
 * reason (the child-error classifier, summaries for a parent, repeat checks) read it with `errorMessageText`.
 */

import type { Instance } from '../../shared/types/instance.types';
import { presentError, type PresentedError } from '../../shared/present-error';
import { isProviderAuthenticationError } from '../cli/adapters/provider-authentication-error';
import { isSessionNotFoundText } from '../cli/adapters/resume-error-classifier';
import { ProviderConcurrencyTimeoutError } from '../cli/provider-concurrency-limiter';
import { buildUsageLimitNotice } from '../cli/usage-limit-notice';
import { isAbortError } from '../util/error-utils';
import { detectAuthFailureSignal } from './instance-auth-failure-detection';
import type { ProviderLimitTurnSignal } from './instance-provider-limit-detection';
import { usageLimitAccountName } from './instance-usage-limit-announcement';
import { redactSpawnFailureText } from './lifecycle/spawn-transaction';

export interface FailureToPresent {
  /** The error as it was thrown, for its own class and code. */
  error: unknown;
  /** The error's message. It is cleaned of secrets and kept under Details; it never becomes a sentence. */
  message: string;
  instance: Pick<Instance, 'provider' | 'accountProfileId'>;
  /** Set when the failure is a provider usage limit that nothing took charge of: what the detector read from it. */
  limit?: ProviderLimitTurnSignal | null;
  /** Opens the sentence when what failed needs saying first ("This session could not start."). */
  lead?: string;
}

export interface UserFacingFailure {
  /** What the person reads. */
  content: string;
  /** What rides on the message: the presentation (its `rawDetail` is the real reason) and, for a limit, its window. */
  metadata: Record<string, unknown>;
}

/**
 * A lost provider session keeps wording that restore and history already recognise as one
 * (`isSessionNotFoundText`), so the line is still left out of a restored conversation.
 */
const LOST_SESSION = 'That session does not exist any more.';

/** What the presenter can tell from the error itself: a stop, a sign-out, or a code it knows. */
function codeOf(error: unknown, detail: string): string | undefined {
  if (isAbortError(error)) return 'cancelled';
  if (isProviderAuthenticationError(error) || detectAuthFailureSignal(detail)) return 'auth';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function presentFailure(input: FailureToPresent): UserFacingFailure {
  const { error, message, instance, limit, lead } = input;
  const detail = redactSpawnFailureText(message);

  if (limit) {
    const notice = buildUsageLimitNotice({
      provider: instance.provider,
      account: usageLimitAccountName(instance.provider, instance.accountProfileId),
      accountProfileId: instance.accountProfileId,
      ...(limit.resetAtHint !== null ? { resetAt: limit.resetAtHint } : {}),
      rawDetail: detail,
    });
    return { content: [lead, notice.content].filter(Boolean).join(' '), metadata: notice.metadata };
  }

  // The limiter's own error already carries its presentation, with the real numbers in the sentence.
  const own = error instanceof ProviderConcurrencyTimeoutError ? error.errorPresentation : undefined;
  const presentation: PresentedError = own
    ? { ...own, rawDetail: redactSpawnFailureText(own.rawDetail) }
    : presentError({ code: codeOf(error, detail), message: detail }, { provider: instance.provider });
  // A sign-out or a stop is what it says even when its words also read as a lost session ("OAuth session expired").
  // After a lead such as "This session could not start.", the presenter's "couldn't finish this request" says nothing new.
  const unnamed = presentation.category === 'unknown';
  const headline = unnamed && isSessionNotFoundText(detail) ? LOST_SESSION
    : unnamed && lead ? undefined
      : presentation.headline;
  return {
    content: [lead, headline, presentation.whatToDo].filter(Boolean).join(' '),
    metadata: { errorPresentation: presentation },
  };
}
