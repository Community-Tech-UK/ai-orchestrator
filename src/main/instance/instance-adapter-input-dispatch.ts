import { getLogger } from '../logging/logger';
import type { AdapterInputDispatch, AdapterInputRetryReason } from '../cli/adapters/base-cli-adapter.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { assertGlobalPauseInputCurrent, runWithGlobalPauseInput } from '../global-pause/global-pause-input';
import { getSessionAdmissionService } from '../session/session-admission-service';
import type { FileAttachment } from '../../shared/types/instance.types';
import type { Instance } from '../../shared/types/instance.types';
import { throwIfInstanceInputAborted, type InstanceSendInputOptions } from './instance-input-cancellation';
import { captureInstanceRecoveryEpoch, isInstanceRecoveryEpochCurrent } from './instance-turn-ending-state';
import { claimMessageDelivery } from './message-delivery';
import { isKnownSendRefusal } from '../../shared/utils/send-refusal';
const logger = getLogger('InstanceInputReceipt');

/** Keeps request and provider identity authoritative after the first input write commits. */
export function createInstanceAdapterInputDispatch(
  instance: Instance,
  adapter: CliAdapter,
  options: InstanceSendInputOptions | undefined,
  commit: () => void,
  getInstance: (id: string) => Instance | undefined,
  getAdapter: (id: string) => CliAdapter | undefined,
): AdapterInputDispatch {
  const recoveryEpoch = captureInstanceRecoveryEpoch(instance.id);
  let retryReason: AdapterInputRetryReason | undefined;
  let identity: Pick<Instance, 'requestCount' | 'sessionId' | 'adapterGeneration' | 'provider'> | undefined;
  const assertCurrent = (): void => {
    throwIfInstanceInputAborted(options?.signal);
    options?.assertProviderDispatchCurrent?.(retryReason);
    const current = getInstance(instance.id);
    if (current === instance && getAdapter(instance.id) === adapter && (!identity
      || (current.requestCount === identity.requestCount && current.sessionId === identity.sessionId
        && current.adapterGeneration === identity.adapterGeneration && current.provider === identity.provider))) return;
    const error = new Error('Instance request or provider changed before native input dispatch');
    error.name = 'AbortError';
    throw error;
  };
  return {
    signal: options?.signal, autoContinuation: options?.autoContinuation, assertCurrent,
    isRecoveryCurrent: () => isInstanceRecoveryEpochCurrent(instance.id, recoveryEpoch),
    assertLogicalCurrent: (reason) => {
      throwIfInstanceInputAborted(options?.signal);
      options?.assertProviderDispatchCurrent?.(reason);
    },
    runInputRetry: async (reason, work) => {
      const previous = retryReason;
      retryReason = reason;
      try { return await runWithGlobalPauseInput(instance.id, options, work); } finally { retryReason = previous; }
    },
    beforeProviderDispatch: () => {
      assertGlobalPauseInputCurrent(instance.id, options);
      assertCurrent();
      commit();
      identity ??= { requestCount: instance.requestCount, sessionId: instance.sessionId,
        adapterGeneration: instance.adapterGeneration, provider: instance.provider };
    },
  };
}

/** A retry shares the original admission; only a successful send marks delivery. */
export function createInstanceInputReceipt(
  instanceId: string,
  getInput: () => { message: string; attachments?: FileAttachment[]; contextBlock?: string | null },
  queuedAdmissionId?: string,
  onDelivered?: () => void,
): { record: () => void; delivered: () => void; failed: (error: unknown) => void } {
  let admission: ReturnType<ReturnType<typeof getSessionAdmissionService>['recordUserSend']> = null;
  let observed = false;
  const notifyDelivery = claimMessageDelivery(instanceId);
  return {
    record: () => {
      if (admission) return; // The same send may consume a preparation failure locally.
      const input = getInput();
      admission = getSessionAdmissionService().recordUserSend(instanceId, input.message, input.attachments, input.contextBlock,
        ...(queuedAdmissionId ? [queuedAdmissionId] as const : [] as const));
    },
    delivered: () => {
      // A successful physical send must never become a resend because bookkeeping failed.
      try { if (admission) getSessionAdmissionService().markDelivered(admission.admissionId); }
      catch (error) {
        logger.error('Input delivered but delivery bookkeeping failed', error instanceof Error ? error : new Error(String(error)), { instanceId });
      }
      notifyDelivery?.('accepted');
      if (observed) return;
      observed = true;
      try { onDelivered?.(); } catch (error) { logger.warn('Provider delivery observer failed', { instanceId, error }); }
    },
    failed: (error) => {
      if (admission) getSessionAdmissionService().markFailed(admission.admissionId, error instanceof Error ? error.message : String(error));
      notifyDelivery?.(error instanceof Error && isKnownSendRefusal(error.message) ? 'not-accepted' : 'uncertain');
    },
  };
}
