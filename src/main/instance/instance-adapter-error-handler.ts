import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import type { CommunicationDependencies } from './instance-communication.types';
import type { InstanceCommunicationOverflowPolicy } from './instance-communication-overflow-policy';
import type { InstanceInputFailureScope } from './instance-input-failure-scope';
import { getLogger } from '../logging/logger';
import { errorDiagnostic, textDiagnostic } from '../logging/source-diagnostics';
import { getHookManager } from '../hooks/hook-manager';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { emitRecoverySafeAdapterError } from './instance-communication-recovery-safety';
import { isRecoverableStatelessExecTurnError, isRecoverableAcpPromptTurnError, isRecoveringStatus } from './instance-communication-adapter-helpers';
import { isSessionNotFoundText } from '../cli/adapters/resume-error-classifier';
import { getSessionContinuityManagerIfInitialized } from '../session/session-continuity';
import { recoverySessionDiagnostic, redactRecoveryError } from './instance-recovery-redaction';
import { generateId } from '../../shared/utils/id-generator';
import { classifyContextOverflow } from '../context/ptl-retry';
import { dispatchInstanceLifecycleHook } from './instance-lifecycle-hooks';
import { errorIdentityOf } from '../util/error-utils';

const logger = getLogger('InstanceCommunication');
export interface InstanceAdapterErrorHost {
  deps: CommunicationDependencies;
  hookManager: ReturnType<typeof getHookManager>;
  overflowPolicy: InstanceCommunicationOverflowPolicy;
  emitInvalidSessionNotice(instanceId: string, instance: Instance): void;
  tryParkOnProviderLimit(instanceId: string, instance: Instance, adapter: CliAdapter, error: unknown, message: string): boolean;
  reportAuthFailureTurn(instanceId: string, error: unknown): void;
  hasRecentMatchingErrorOutput(instance: Instance, content: string): boolean;
  addToOutputBuffer(instance: Instance, message: OutputMessage): void;
  emitOutput(instanceId: string, message: OutputMessage): void;
  transitionInstanceStatus(instance: Instance, status: InstanceStatus): void;
  forceCleanupAdapter(instanceId: string): Promise<void>;
}

/** Returns whether event-owned recovery handled this failure; delivery is a separate native outcome. */
export async function handleInstanceAdapterError(
  host: InstanceAdapterErrorHost,
  instanceId: string,
  adapter: CliAdapter,
  error: Error,
  emitProviderRuntimeEvent: (event: ProviderRuntimeEvent) => void,
  scope?: InstanceInputFailureScope,
): Promise<boolean> {
  if (scope && !scope.isCurrent()) return true;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const recoverableStatelessExecError = isRecoverableStatelessExecTurnError(adapter, error);
  const recoverableAcpPromptTurnError = isRecoverableAcpPromptTurnError(errorMessage);
  const recoverableTurnError = recoverableStatelessExecError || recoverableAcpPromptTurnError;
  const instance = host.deps.getInstance(instanceId);
  const safeError = emitRecoverySafeAdapterError(instanceId, instance, error, recoverableTurnError, emitProviderRuntimeEvent);
  const safeErrorMessage = safeError.message;
  if (scope && !scope.isCurrent()) return true;

  if (!instance) return false;

  // Guard: EPIPE errors are expected when a CLI process dies while we have
  // buffered writes. Swallow them — the exit handler will take care of
  // respawning. Emitting EPIPE as an instance error would race with the
  // exit handler and could mark the instance as 'error' before auto-respawn
  // gets a chance to run, which kills the session.
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    logger.debug('Ignoring EPIPE error from adapter — exit handler will manage recovery', { instanceId });
    return false;
  }

  // Poison the session id on the telltale Claude CLI resume failure so
  // the next respawn (including auto-respawn from this adapter's exit)
  // cannot loop on it.
  const errText = errorMessage;
  if (isSessionNotFoundText(errText)) {
    const firstBlacklist = !instance.sessionResumeBlacklisted;
    instance.sessionResumeBlacklisted = true;
    logger.warn('Session id blacklisted due to resume failure', {
      instanceId,
      ...recoverySessionDiagnostic(instance, 'sessionId', instance.sessionId),
    });
    if (firstBlacklist) host.emitInvalidSessionNotice(instanceId, instance);
    // B4/C1: Persist blacklist immediately so a crash cannot replay the
    // doomed session ID. Awaited so the save completes before this handler
    // returns — eliminates the crash window between in-memory update and disk.
    try {
      await getSessionContinuityManagerIfInitialized()?.writeThroughIdentity(instanceId, {
        nativeResumeFailedAt: Date.now(),
      });
    } catch (err: unknown) {
      logger.warn('writeThroughIdentity failed after blacklist set (error)', {
        instanceId,
        ...errorDiagnostic(redactRecoveryError(instance, err)),
      });
    }
  }

  if (scope && !scope.isCurrent()) return true;

  // Check if this is a context overflow error
  const overflowEvidence = classifyContextOverflow({
    errorText: errorMessage,
    promptTokens: instance.contextUsage?.inputTokens ?? instance.contextUsage?.used,
    contextWindowTokens: instance.contextUsage?.total,
  });
  const classified = getErrorRecoveryManager().classifyError(error);
  if (
    overflowEvidence.matched
    || (classified.category === ErrorCategory.RESOURCE && classified.technicalDetails?.includes('context'))
  ) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const handled = await host.overflowPolicy.recoverAdapterErrorOverflow({
      instanceId,
      instance,
      errorText: errorMsg,
      onRetryDelivered: scope ? () => scope.markRetryDelivered() : undefined,
      extraFields: overflowEvidence.matched
        ? { reason: overflowEvidence.reason, detail: overflowEvidence.detail }
        : undefined,
    });
    if (scope && !scope.isCurrent()) return true;
    if (handled) return true;
  }

  // Regular-session provider-limit auto-resume (opt-in). If this turn
  // stopped on a rate/session limit, park the instance and schedule a
  // resume after the quota window resets instead of marking it errored.
  // A scoped rejected send joins this outcome instead of parking a second time.
  if (host.deps.onProviderLimitTurn && (!recoverableTurnError || scope)) {
    if (host.tryParkOnProviderLimit(
      instanceId, instance, adapter, safeError, safeErrorMessage,
    )) {
      return true;
    }
  }

  // Provider sign-out mid-session: attach the repair affordance. The error
  // below is still surfaced and the instance still errors — this only adds
  // the auth-required waitReason and the sign-in watcher.
  host.reportAuthFailureTurn(instanceId, safeError);

  // Add error message to output buffer so user sees it in the UI
  const errorContent = safeErrorMessage;
  if (host.hasRecentMatchingErrorOutput(instance, errorContent)) {
    logger.debug('Skipping duplicate UI error message after adapter error event', {
      instanceId,
      ...textDiagnostic(errorContent),
    });
  } else {
    const errorMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      content: errorContent,
      metadata: errorIdentityOf(error),
    };
    host.addToOutputBuffer(instance, errorMessage);
    host.emitOutput(instanceId, errorMessage);
  }

  if (recoverableTurnError) {
    instance.errorCount++;
    logger.info('Keeping instance recoverable after turn failure', {
      instanceId,
      adapter: adapter.getName(),
      ...textDiagnostic(safeErrorMessage),
      recoverableKind: recoverableAcpPromptTurnError ? 'acp-prompt-timeout' : 'stateless-exec',
    });
    if (!isRecoveringStatus(instance.status)) {
      host.transitionInstanceStatus(instance, 'idle');
      host.deps.onToolStateChange?.(instanceId, 'idle');
      host.deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
    }
    return false;
  }

  instance.errorCount++;
  dispatchInstanceLifecycleHook('StopFailure', instance, {
    errorMessage: errorContent,
    errorProvider: instance.provider,
    stopReason: 'adapter-error',
  }, logger, host.hookManager);

  // Don't mark as error if we're in the middle of interrupt recovery - let lifecycle handle it.
  if (!isRecoveringStatus(instance.status)) {
    host.transitionInstanceStatus(instance, 'error');
    host.deps.queueUpdate(instanceId, 'error');

    // Only force cleanup if not recovering - during recovery the lifecycle manager handles cleanup.
    host.forceCleanupAdapter(instanceId).catch((cleanupErr) => {
      logger.error(
        'Failed to cleanup adapter after error',
        undefined,
        { instanceId, ...errorDiagnostic(redactRecoveryError(instance, cleanupErr)) },
      );
    });
  } else {
    logger.info('Instance error during interrupt recovery - skipping force cleanup, letting lifecycle handle it', { instanceId });
  }

  return false;
}
