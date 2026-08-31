import type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventRaw,
} from '@contracts/types/provider-runtime-events';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import { getLogger } from '../logging/logger';
import { toJsonSafeProviderEventPayload } from '../providers/provider-event-raw-payload';
import { extractProviderErrorDiagnostics } from './instance-communication.diagnostics';
import type { CommunicationDependencies } from './instance-communication.types';
import {
  getRecoverySensitiveValues,
  isCrashRecoveryInstance,
  markPendingRecoveryAdapterExit,
  redactRecoveryError,
  redactRecoveryIdentityValue,
} from './instance-recovery-redaction';

const logger = getLogger('InstanceCommunication');

type RuntimeErrorEmitter = (
  event: ProviderRuntimeEvent,
  options: { raw: ProviderRuntimeEventRaw },
) => void;

export function notePendingRecoveryExit(
  instance: Instance | undefined,
  code: number | null,
  signal: string | null,
): void {
  if (instance && isCrashRecoveryInstance(instance)) markPendingRecoveryAdapterExit(instance, code, signal);
}

/** Publish adapter errors without exposing a crash-recovery cursor through diagnostics or raw data. */
export function emitRecoverySafeAdapterError(
  instanceId: string,
  instance: Instance | undefined,
  error: Error,
  recoverable: boolean,
  emit: RuntimeErrorEmitter,
): Error {
  const safeError = redactRecoveryError(instance, error);
  const sensitiveValues = instance && isCrashRecoveryInstance(instance)
    ? getRecoverySensitiveValues(instance)
    : undefined;
  const runtimeEvent = {
    kind: 'error' as const,
    message: safeError.message,
    recoverable,
    ...extractProviderErrorDiagnostics(error),
  };
  emit(
    (sensitiveValues
      ? redactRecoveryIdentityValue(runtimeEvent, sensitiveValues)
      : runtimeEvent) as ProviderRuntimeEvent,
    { raw: {
      source: 'adapter-event:error',
      payload: (sensitiveValues
        ? redactRecoveryIdentityValue(toJsonSafeProviderEventPayload(error), sensitiveValues)
        : toJsonSafeProviderEventPayload(error)) as ProviderRuntimeEventRaw['payload'],
    } },
  );
  logger.error(
    'Instance error',
    isCrashRecoveryInstance(instance) ? undefined : safeError,
    {
      instanceId,
      status: instance?.status,
      ...(isCrashRecoveryInstance(instance) ? { recoverySession: true } : {}),
    },
  );
  return safeError;
}

interface ExitRecoveryFailureDependencies {
  queueUpdate: CommunicationDependencies['queueUpdate'];
  transitionInstanceStatus(instance: Instance, status: InstanceStatus): void;
  buildCrashError(reason: string): ErrorInfo;
}

/** Settle a failed exit recovery through the same redacted terminal path. */
export function settleExitRecoveryFailure(
  deps: ExitRecoveryFailureDependencies,
  instanceId: string,
  instance: Instance,
  error: unknown,
  logMessage: string,
  crashMessagePrefix: string,
): void {
  const safeError = redactRecoveryError(instance, error);
  logger.error(logMessage, safeError, { instanceId });
  deps.transitionInstanceStatus(instance, 'error');
  instance.processId = null;
  deps.queueUpdate(
    instanceId,
    'error',
    undefined,
    undefined,
    undefined,
    deps.buildCrashError(`${crashMessagePrefix}: ${safeError.message}`),
  );
}
