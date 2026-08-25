/**
 * `INSTANCE_CREATE_WITH_MESSAGE` body + entry logging.
 *
 * Split out of `instance-handlers.ts` so the create path can be logged and
 * deduplicated without growing that file further.
 */

import type { SubsystemLogger } from '../../logging/logger';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { FileAttachment, InstanceProvider } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { createInitialUserMessage, serializeInstance } from './instance-handler-serializers';

/** Shape actually consumed here; kept structural so the Zod type stays the source of truth. */
export interface CreateWithMessageInput {
  message: string;
  launchMode?: 'orchestrated' | 'interactive';
  agentId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: unknown;
  modelRuntimeTarget?: unknown;
  yoloMode?: boolean;
  bareMode?: boolean;
  fastMode?: boolean;
  forceNodeId?: string;
  nodePlacement?: unknown;
  browserToolsMode?: 'eager' | 'deferred' | 'off';
  hardened?: boolean;
  copilotAccountProfileId?: string;
  copilotConfirmProtectedOverride?: boolean;
}

/**
 * Records that a submission reached the main process, before validation.
 *
 * Deliberately defensive about the payload shape: this runs on unvalidated
 * input, and its whole purpose is to leave evidence when that input is about
 * to be rejected.
 */
export function logCreateWithMessageReceived(logger: SubsystemLogger, payload: unknown): void {
  const record = (payload ?? {}) as Record<string, unknown>;
  const attachments = Array.isArray(record['attachments']) ? record['attachments'] : [];
  logger.info('IPC INSTANCE_CREATE_WITH_MESSAGE received', {
    submissionId: typeof record['idempotencyKey'] === 'string' ? record['idempotencyKey'] : null,
    workingDirectory: typeof record['workingDirectory'] === 'string' ? record['workingDirectory'] : null,
    messageLength: typeof record['message'] === 'string' ? record['message'].length : 0,
    attachmentsCount: attachments.length,
    attachmentNames: attachments
      .map((entry) => (entry as Record<string, unknown> | null)?.['name'])
      .filter((name): name is string => typeof name === 'string'),
  });
}

export async function createInstanceWithMessage(
  manager: InstanceManager,
  validated: CreateWithMessageInput,
  workingDirectory: string,
  attachments: FileAttachment[] | undefined,
): Promise<IpcResponse> {
  const instance = await manager.createInstance({
    workingDirectory,
    initialPrompt: validated.message,
    attachments,
    initialOutputBuffer: [createInitialUserMessage(validated.message, attachments)],
    launchMode: validated.launchMode,
    agentId: validated.agentId,
    provider: validated.provider as InstanceProvider | undefined,
    modelOverride: validated.model,
    reasoningEffort: validated.reasoningEffort as never,
    modelRuntimeTarget: validated.modelRuntimeTarget as never,
    yoloMode: validated.yoloMode,
    bareMode: validated.bareMode,
    fastModeOverride: validated.fastMode,
    forceNodeId: validated.forceNodeId,
    nodePlacement: validated.nodePlacement as never,
    browserToolsMode: validated.browserToolsMode,
    hardened: validated.hardened,
    copilotAccountProfileId: validated.copilotAccountProfileId,
    copilotConfirmProtectedOverride: validated.copilotConfirmProtectedOverride,
  });

  return { success: true, data: serializeInstance(instance) };
}
