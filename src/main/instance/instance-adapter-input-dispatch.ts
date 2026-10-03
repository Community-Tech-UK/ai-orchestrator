import type { AdapterInputDispatch, AdapterInputRetryReason } from '../cli/adapters/base-cli-adapter.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { getSessionAdmissionService } from '../session/session-admission-service';
import type { FileAttachment } from '../../shared/types/instance.types';
import type { Instance } from '../../shared/types/instance.types';
import { throwIfInstanceInputAborted, type InstanceSendInputOptions } from './instance-input-cancellation';

/** Keeps request and provider identity authoritative after the first input write commits. */
export function createInstanceAdapterInputDispatch(
  instance: Instance,
  adapter: CliAdapter,
  options: InstanceSendInputOptions | undefined,
  commit: () => void,
  getInstance: (id: string) => Instance | undefined,
  getAdapter: (id: string) => CliAdapter | undefined,
): AdapterInputDispatch {
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
    runInputRetry: async (reason, work) => {
      const previous = retryReason;
      retryReason = reason;
      try { return await work(); } finally { retryReason = previous; }
    },
    beforeProviderDispatch: () => {
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
): { record: () => void; delivered: () => void; failed: (error: unknown) => void } {
  let admission: ReturnType<ReturnType<typeof getSessionAdmissionService>['recordUserSend']> = null;
  return {
    record: () => {
      const input = getInput();
      admission = getSessionAdmissionService().recordUserSend(instanceId, input.message, input.attachments, input.contextBlock);
    },
    delivered: () => { if (admission) getSessionAdmissionService().markDelivered(admission.admissionId); },
    failed: (error) => {
      if (admission) getSessionAdmissionService().markFailed(admission.admissionId, error instanceof Error ? error.message : String(error));
    },
  };
}
