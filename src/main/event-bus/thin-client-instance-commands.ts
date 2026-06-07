import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceCreatePayloadSchema,
  InstanceInterruptPayloadSchema,
  InstanceSendInputPayloadSchema,
  InstanceTerminatePayloadSchema,
} from '@contracts/schemas/instance';
import type {
  FileAttachment,
  Instance,
  InstanceCreateConfig,
  InstanceProvider,
} from '../../shared/types/instance.types';
import type { IpcResponse } from '../../shared/types/ipc.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { serializeInstance } from '../ipc/handlers/instance-handler-serializers';
import type { ThinClientCommandExecutorDeps } from './thin-client-command-executor';

export async function createInstance(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  const validated = validateIpcPayload(
    InstanceCreatePayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_CREATE',
  );
  const instance = await deps.instanceManager.createInstance({
    workingDirectory: resolveWorkingDirectory(deps, validated.workingDirectory),
    sessionId: validated.sessionId,
    parentId: validated.parentInstanceId,
    displayName: validated.displayName,
    initialPrompt: validated.initialPrompt,
    attachments: validated.attachments as FileAttachment[] | undefined,
    yoloMode: validated.yoloMode,
    launchMode: validated.launchMode,
    agentId: validated.agentId,
    provider: validated.provider as InstanceProvider | undefined,
    modelOverride: validated.model,
    forceNodeId: validated.forceNodeId,
  } satisfies InstanceCreateConfig);

  return {
    success: true,
    data: serializeInstance(instance as Instance),
  };
}

export async function sendInput(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  const validated = validateIpcPayload(
    InstanceSendInputPayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_SEND_INPUT',
  );
  await deps.instanceManager.sendInput(
    validated.instanceId,
    validated.message,
    validated.attachments as FileAttachment[] | undefined,
    { isRetry: validated.isRetry },
  );
  return { success: true };
}

export async function terminateInstance(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  const validated = validateIpcPayload(
    InstanceTerminatePayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_TERMINATE',
  );
  await deps.instanceManager.terminateInstance(
    validated.instanceId,
    validated.graceful ?? true,
  );
  return { success: true };
}

export function interruptInstance(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): IpcResponse {
  const validated = validateIpcPayload(
    InstanceInterruptPayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_INTERRUPT',
  );
  const interrupted = deps.instanceManager.interruptInstance(validated.instanceId);
  return {
    success: interrupted,
    data: { interrupted },
  };
}

export async function hibernateInstance(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  const validated = validateIpcPayload(
    InstanceInterruptPayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_HIBERNATE',
  );
  await deps.instanceManager.hibernateInstance(validated.instanceId);
  return { success: true };
}

export async function wakeInstance(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  const validated = validateIpcPayload(
    InstanceInterruptPayloadSchema,
    payload,
    'THIN_CLIENT_INSTANCE_WAKE',
  );
  await deps.instanceManager.wakeInstance(validated.instanceId);
  return { success: true };
}

function resolveWorkingDirectory(
  deps: ThinClientCommandExecutorDeps,
  requested: string | undefined,
): string {
  if (requested && requested !== '.') {
    return requested;
  }
  return deps.getDefaultWorkingDirectory?.()
    || getSettingsManager().get('defaultWorkingDirectory')
    || process.cwd();
}
