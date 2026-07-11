import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import { ModelsLocalReviewerQualifyPayloadSchema } from '@contracts/schemas/provider';
import type { LocalReviewerQualification } from '../../review/local-reviewer-capability-service';

interface QualificationControllerLike {
  qualify(selectorId: string): Promise<LocalReviewerQualification>;
}

type EnsureAuthorized = (
  event: IpcMainInvokeEvent,
  channel: string,
  payload: unknown,
) => IpcResponse | null;

export async function handleLocalReviewerQualification(
  event: IpcMainInvokeEvent,
  payload: unknown,
  controller: QualificationControllerLike,
  ensureAuthorized: EnsureAuthorized,
): Promise<IpcResponse> {
  const authError = ensureAuthorized(event, IPC_CHANNELS.MODELS_LOCAL_REVIEWER_QUALIFY, payload);
  if (authError) return authError;
  try {
    const validated = validateIpcPayload(
      ModelsLocalReviewerQualifyPayloadSchema,
      payload,
      'MODELS_LOCAL_REVIEWER_QUALIFY',
    );
    return { success: true, data: await controller.qualify(validated.selectorId) };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'MODELS_LOCAL_REVIEWER_QUALIFY_FAILED',
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
    };
  }
}
