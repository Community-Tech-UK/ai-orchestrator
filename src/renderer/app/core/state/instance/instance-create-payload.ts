import type { CreateInstanceWithMessageConfig } from '../../services/ipc/instance-ipc.service';
import type { InstanceAttachment } from './instance-attachments';
import type { CreateInstanceWithMessageOptions } from './instance-list.store';

/**
 * Assemble the `INSTANCE_CREATE_WITH_MESSAGE` payload.
 *
 * Optional keys are omitted rather than sent as `undefined` so the Zod schema
 * on the main side sees exactly what the caller meant — a create rejected at
 * validation produces no session and, before this work, no log either.
 */
export function buildCreateWithMessagePayload(
  options: CreateInstanceWithMessageOptions,
  attachments: InstanceAttachment[] | undefined,
  fastMode: boolean | undefined,
): CreateInstanceWithMessageConfig {
  return {
    workingDirectory: options.workingDirectory || '.',
    message: options.message,
    attachments,
    launchMode: options.launchMode,
    agentId: options.agentId,
    provider: options.provider === 'auto' ? undefined : options.provider,
    model: options.model,
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.modelRuntimeTarget ? { modelRuntimeTarget: options.modelRuntimeTarget } : {}),
    ...(typeof options.yoloMode === 'boolean' ? { yoloMode: options.yoloMode } : {}),
    bareMode: options.bareMode,
    fastMode,
    ...(options.hardened ? { hardened: true } : {}),
    forceNodeId: options.forceNodeId,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
}
