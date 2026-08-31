import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  RecoverSessionRequestSchema,
  RecoverSessionResultSchema,
  SessionRecoveryCandidateSchema,
  SessionRecoveryListPayloadSchema,
  SessionRecoveryListResultSchema,
} from '@contracts/schemas/session';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type {
  RecoverSessionRequest,
  RecoverSessionResult,
  SessionRecoveryCandidate,
} from '../../../shared/types/session-recovery.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getLogger } from '../../logging/logger';
import { isOrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import {
  getSessionRecoveryCandidateServiceIfInitialized,
  type ResolvedRecoveryCandidate,
  type SessionRecoveryCandidateService,
} from '../../session/session-recovery-candidate-service';

const logger = getLogger('SessionRecoveryHandlers');

type RecoveryIpcListener = (
  event: IpcMainInvokeEvent,
  payload: unknown,
) => Promise<IpcResponse>;

interface RegisterSessionRecoveryHandlersDeps {
  instanceManager: Pick<InstanceManager, 'recoverFromContinuity'>;
  registerIpcHandler(channel: string, listener: RecoveryIpcListener): void;
}

function responseError(code: string, message: string): IpcResponse {
  return {
    success: false,
    error: { code, message, timestamp: Date.now() },
  };
}

function validationError(channel: string, error: unknown): IpcResponse {
  const message = error instanceof Error
    ? error.message.replace('IPC validation failed', 'Validation failed')
    : `Validation failed for ${channel}`;
  return responseError('VALIDATION_FAILED', message);
}

function recoveryServiceUnavailable(): IpcResponse {
  return responseError(
    'SESSION_RECOVERY_UNAVAILABLE',
    'Session recovery is not available yet',
  );
}

function getRecoveryService(): SessionRecoveryCandidateService | null {
  return getSessionRecoveryCandidateServiceIfInitialized();
}

function publicCandidate(candidate: SessionRecoveryCandidate): SessionRecoveryCandidate | null {
  const parsed = SessionRecoveryCandidateSchema.safeParse({
    recoveryKey: candidate.recoveryKey,
    sourceInstanceId: candidate.sourceInstanceId,
    historyThreadId: candidate.historyThreadId,
    provider: candidate.provider,
    modelId: candidate.modelId,
    displayName: candidate.displayName,
    workingDirectory: candidate.workingDirectory,
    lastActivityAt: candidate.lastActivityAt,
    historyCoveredThrough: candidate.historyCoveredThrough,
    recoveredMessageCount: candidate.recoveredMessageCount,
    reason: candidate.reason,
    nativeResumeAvailable: candidate.nativeResumeAvailable,
  });
  return parsed.success ? parsed.data as SessionRecoveryCandidate : null;
}

function publicRecoveryResult(result: RecoverSessionResult): RecoverSessionResult {
  return RecoverSessionResultSchema.parse({
    instanceId: result.instanceId,
    recoveredMessageCount: result.recoveredMessageCount,
    usedNativeResume: result.usedNativeResume,
  }) as RecoverSessionResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : null;
}

function restoreFailure(error: unknown): IpcResponse {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code === 'ORCHESTRATOR_PAUSED' || isOrchestratorPausedError(error)) {
    return responseError(
      'ORCHESTRATOR_PAUSED',
      'Session recovery refused while orchestrator is paused',
    );
  }
  if (message.startsWith('Recovery candidate is unavailable')
      || message.startsWith('Recovery source is unavailable')) {
    return responseError(
      'SESSION_RECOVERY_NOT_FOUND',
      'Recovery candidate is no longer available',
    );
  }
  if (message.startsWith('Recovery candidate validation failed')) {
    return responseError(
      'SESSION_RECOVERY_VALIDATION_FAILED',
      'Recovery candidate validation failed',
    );
  }
  if (code === 'PROVIDER_UNAVAILABLE' || /\bprovider\b.*\bunavailable\b/iu.test(message)) {
    return responseError(
      'SESSION_RECOVERY_PROVIDER_UNAVAILABLE',
      'Recovery provider is unavailable',
    );
  }
  if (message === 'Recovery replacement failed to start'
      || /\breplacement runtime\b.*\bready\b/iu.test(message)
      || /\bfailed to start\b/iu.test(message)) {
    return responseError(
      'SESSION_RECOVERY_START_FAILED',
      'Recovery replacement failed to start',
    );
  }
  return responseError('SESSION_RECOVERY_RESTORE_FAILED', 'Session recovery failed');
}

async function listRecoveryCandidates(payload: unknown): Promise<IpcResponse<SessionRecoveryCandidate[]>> {
  try {
    validateIpcPayload(SessionRecoveryListPayloadSchema, payload, 'SESSION_RECOVERY_LIST');
  } catch (error) {
    return validationError('SESSION_RECOVERY_LIST', error) as IpcResponse<SessionRecoveryCandidate[]>;
  }

  const service = getRecoveryService();
  if (!service) return recoveryServiceUnavailable() as IpcResponse<SessionRecoveryCandidate[]>;

  try {
    const discovered = await service.listCandidates();
    const candidates = discovered.flatMap((candidate) => {
      const parsed = publicCandidate(candidate);
      return parsed ? [parsed] : [];
    });
    const skipped = discovered.length - candidates.length;
    if (skipped > 0) {
      logger.warn('Skipped invalid session recovery candidates', { skipped });
    }
    return {
      success: true,
      data: SessionRecoveryListResultSchema.parse(candidates) as SessionRecoveryCandidate[],
    };
  } catch {
    return responseError(
      'SESSION_RECOVERY_LIST_FAILED',
      'Session recovery candidates could not be loaded',
    ) as IpcResponse<SessionRecoveryCandidate[]>;
  }
}

async function recoverSession(
  instanceManager: Pick<InstanceManager, 'recoverFromContinuity'>,
  payload: unknown,
): Promise<IpcResponse<RecoverSessionResult>> {
  let request: RecoverSessionRequest;
  try {
    request = validateIpcPayload(RecoverSessionRequestSchema, payload, 'SESSION_RECOVERY_RESTORE');
  } catch (error) {
    return validationError('SESSION_RECOVERY_RESTORE', error) as IpcResponse<RecoverSessionResult>;
  }

  const service = getRecoveryService();
  if (!service) return recoveryServiceUnavailable() as IpcResponse<RecoverSessionResult>;

  try {
    const resolved: ResolvedRecoveryCandidate = await service.resolveCandidate(request.recoveryKey);
    const result = await instanceManager.recoverFromContinuity(resolved);
    return { success: true, data: publicRecoveryResult(result) };
  } catch (error) {
    return restoreFailure(error) as IpcResponse<RecoverSessionResult>;
  }
}

export function registerSessionRecoveryHandlers(deps: RegisterSessionRecoveryHandlersDeps): void {
  deps.registerIpcHandler(
    IPC_CHANNELS.SESSION_RECOVERY_LIST,
    async (_event, payload) => listRecoveryCandidates(payload),
  );
  deps.registerIpcHandler(
    IPC_CHANNELS.SESSION_RECOVERY_RESTORE,
    async (_event, payload) => recoverSession(deps.instanceManager, payload),
  );
}
