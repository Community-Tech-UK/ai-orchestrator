/**
 * Interpret an unconfirmed native-resume attempt.
 *
 * Extracted from `instance-lifecycle.ts` so the coordinator stays inside its
 * LOC ceiling. The caller still owns the proof wait and adapter lookup;
 * this only classifies a known unconfirmed result. Behaviour matches the
 * previous inline branch.
 */

import { getLogger } from '../../logging/logger';
import type { ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter';
import type { ResumeHealthVerdict } from './runtime-readiness';

const logger = getLogger('InstanceLifecycle');

export function interpretUnconfirmedResumeAttempt(
  instanceId: string,
  resumeResult: ResumeAttemptResult,
  isCrashRecovery: boolean,
): ResumeHealthVerdict {
  // EXPECTED case: the adapter never attempted native resume because no
  // transcript exists for this session under the cwd (e.g. a first turn
  // that never flushed). Definite non-resume — fall back to fresh+replay.
  if (resumeResult.source === 'fresh-fallback') {
    logger.info('Native resume unavailable (no transcript for session under cwd); starting fresh with replay', {
      instanceId,
      ...(isCrashRecovery
        ? { recoverySession: true }
        : { requestedSessionId: resumeResult.requestedSessionId }),
    });
    return 'unrecoverable';
  }

  // A confirmed WRONG session (id echoed back differs from requested) is
  // a real failure — the CLI silently started a different conversation.
  if (
    resumeResult.actualSessionId
    && resumeResult.requestedSessionId
    && resumeResult.actualSessionId !== resumeResult.requestedSessionId
  ) {
    logger.warn('Native resume landed on a different session id', {
      instanceId,
      source: resumeResult.source,
      ...(isCrashRecovery
        ? { recoverySession: true }
        : {
            requestedSessionId: resumeResult.requestedSessionId,
            actualSessionId: resumeResult.actualSessionId,
            reason: resumeResult.reason,
          }),
    });
    return 'unrecoverable';
  }

  // Attempted native resume, alive, but the confirming session-id echo
  // hasn't arrived within the window. Unproven is not dead: report
  // `inconclusive` so recovery keeps the (very likely healthy) session
  // instead of destroying its context.
  logger.info('Native resume attempted but unconfirmed within probe window; treating as inconclusive', {
    instanceId,
    source: resumeResult.source,
    ...(isCrashRecovery
      ? { recoverySession: true }
      : {
          requestedSessionId: resumeResult.requestedSessionId,
          reason: resumeResult.reason,
        }),
  });
  return 'inconclusive';
}
