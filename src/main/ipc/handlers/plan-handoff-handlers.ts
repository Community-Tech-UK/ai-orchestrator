/**
 * IPC handlers for the build-in-a-new-session handoff (A21, Step 15b).
 *
 * Kept out of `command-handlers.ts` (which owns plan mode and is at its own
 * size budget): this file wires `PlanBuildHandoff` to the instance manager and
 * the orchestration handler's silent-dismiss call.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  PlanHandoffPreviewPayloadSchema,
  PlanHandoffStartPayloadSchema,
} from '@contracts/schemas/instance';
import { validateIpcPayload } from '@contracts/schemas/common';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { PlanBuildHandoff } from '../../instance/plan-handoff/plan-build-handoff';
import { getLogger } from '../../logging/logger';
import { getInstanceCreateIdempotencyCache } from './instance-create-idempotency';

const logger = getLogger('PlanHandoffHandlers');

export function registerPlanHandoffHandlers(instanceManager: InstanceManager): void {
  const handoff = new PlanBuildHandoff({
    getInstance: (id) => instanceManager.getInstance(id),
    createInstance: (config) => instanceManager.createInstance(config),
    dismissUserAction: (requestId) => {
      instanceManager.getOrchestrationHandler().dismissUserAction(requestId);
    },
    approvePlan: (instanceId, planText) => instanceManager.approvePlan(instanceId, planText),
    emitSystemNotice: (instance, content) => {
      instanceManager.emitSystemMessage(instance.id, content);
    },
  });

  ipcMain.handle(
    IPC_CHANNELS.PLAN_HANDOFF_PREVIEW,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanHandoffPreviewPayloadSchema, payload, 'PLAN_HANDOFF_PREVIEW');
        return { success: true, data: handoff.preview(validated.instanceId) };
      } catch (error) {
        return toErrorResponse('PLAN_HANDOFF_PREVIEW_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PLAN_HANDOFF_START,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanHandoffStartPayloadSchema, payload, 'PLAN_HANDOFF_START');
        const run = async (): Promise<IpcResponse> => {
          if (validated.requestId && !instanceManager.getOrchestrationHandler()
            .getPendingUserActionsForInstance(validated.instanceId)
            .some(request => request.id === validated.requestId
              && request.requestType === 'switch_mode' && request.targetMode === 'build')) {
            return toErrorResponse('PLAN_HANDOFF_START_FAILED',
              new Error('This planning request is no longer available.'));
          }
          const result = await handoff.start({
            sourceId: validated.instanceId,
            requestId: validated.requestId,
            planText: validated.planText,
            model: validated.model,
            idempotencyKey: validated.idempotencyKey,
          });
          return result.ok
            ? { success: true, data: result }
            : { success: false, error: { code: 'PLAN_HANDOFF_START_FAILED', message: result.reason ?? 'Could not start the build session.', timestamp: Date.now() } };
        };
        if (!validated.idempotencyKey) return await run();
        // Keep the acknowledgement available after successful request dismissal.
        const key = JSON.stringify([validated.instanceId, validated.requestId ?? null, validated.idempotencyKey]);
        return await getInstanceCreateIdempotencyCache().run(`plan-handoff-ipc:${key}`, run);
      } catch (error) {
        return toErrorResponse('PLAN_HANDOFF_START_FAILED', error);
      }
    },
  );

  logger.info('Plan handoff IPC handlers registered');
}

function toErrorResponse(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}
