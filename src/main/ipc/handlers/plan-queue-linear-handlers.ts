/**
 * Plan Queue IPC handlers for the Linear connection: list the connectors at Linear's address, identify who one signs
 * in as, confirm and save the connection, forget it, and check it now. IPC callers are the operator on the Plan Queue
 * page; agents have no route here. A failure message is fixed words written by Harness, never Linear's own text.
 */
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PlanQueueLinearConfirmPayloadSchema,
  PlanQueueLinearIdentifyPayloadSchema,
  PlanQueueLinearNoPayloadSchema,
} from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLinearConnectionService } from '../../plan-queue/linear/linear-connection-singleton';
import type { WindowManager } from '../../window-manager';
import { broadcastSettingsChanged } from './settings-broadcast';
import { handle } from './plan-queue-ipc-helpers';

export function registerPlanQueueLinearHandlers(deps: { windowManager: Pick<WindowManager, 'sendToRenderer'> }): void {
  const service = getLinearConnectionService();
  // The page watches the setting, so a save from here is announced the way the settings handlers announce theirs.
  const announceSaved = (): void =>
    broadcastSettingsChanged(deps.windowManager, {
      key: 'planQueueLinearConnection',
      value: getSettingsManager().get('planQueueLinearConnection') ?? null,
    });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_LIST, 'PLAN_QUEUE_LINEAR_LIST_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_LIST');
    return service.list();
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_IDENTIFY, 'PLAN_QUEUE_LINEAR_IDENTIFY_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearIdentifyPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_IDENTIFY');
    return service.identify(validated.connectorId);
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_CONFIRM, 'PLAN_QUEUE_LINEAR_CONFIRM_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearConfirmPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_CONFIRM');
    const connection = await service.confirm(validated.connectorId, validated.userId);
    announceSaved();
    return connection;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_FORGET, 'PLAN_QUEUE_LINEAR_FORGET_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_FORGET');
    const connection = service.forget();
    announceSaved();
    return connection;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_CHECK, 'PLAN_QUEUE_LINEAR_CHECK_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_CHECK');
    return service.check();
  });
}
