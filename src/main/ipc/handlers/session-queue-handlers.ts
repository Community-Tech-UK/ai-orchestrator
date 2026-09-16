/**
 * Durable renderer send-queue IPC handlers (WS-A1 Phase B).
 *
 * See session-queue-service.ts for the durable-queue design
 * (SessionAdmissionStore is the shared storage authority).
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import {
  SessionQueueEnqueuePayloadSchema,
  SessionQueueUpdatePayloadSchema,
  SessionQueueCancelPayloadSchema,
  SessionQueueReorderPayloadSchema,
  SessionQueueListPayloadSchema,
  SessionQueuePromotePayloadSchema,
} from '@contracts/schemas/session';
import { getSessionQueueService } from '../../session/session-queue-service';
import { registerValidatedIpcHandler } from '../validated-handler';
import type { FileAttachment } from '../../../shared/types/instance.types';

export interface SessionQueueHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerSessionQueueHandlers(deps: SessionQueueHandlersDeps): void {
  const register = <T>(
    channel: string,
    schema: z.ZodSchema<T>,
    fn: (validated: T) => Promise<IpcResponse> | IpcResponse,
    errorCode: string,
  ): void => {
    registerValidatedIpcHandler(
      channel,
      schema,
      async (validated) => fn(validated),
      { ensureTrustedSender: deps.ensureTrustedSender, errorCode },
    );
  };

  register(
    IPC_CHANNELS.SESSION_QUEUE_ENQUEUE,
    SessionQueueEnqueuePayloadSchema,
    async (payload) => ({
      success: true,
      data: await getSessionQueueService().enqueueUserMessage({
        ...payload,
        attachments: payload.attachments as FileAttachment[] | undefined,
      }),
    }),
    'SESSION_QUEUE_ENQUEUE_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_QUEUE_UPDATE,
    SessionQueueUpdatePayloadSchema,
    async (payload) => ({
      success: true,
      data: await getSessionQueueService().updateQueuedMessage(payload.admissionId, {
        ...payload,
        attachments: payload.attachments as FileAttachment[] | undefined,
      }),
    }),
    'SESSION_QUEUE_UPDATE_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_QUEUE_CANCEL,
    SessionQueueCancelPayloadSchema,
    (payload) => ({
      success: true,
      data: { cancelled: getSessionQueueService().cancelQueuedMessage(payload.admissionId) },
    }),
    'SESSION_QUEUE_CANCEL_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_QUEUE_REORDER,
    SessionQueueReorderPayloadSchema,
    (payload) => {
      getSessionQueueService().reorderQueue(payload.instanceId, payload.orderedIds);
      return { success: true };
    },
    'SESSION_QUEUE_REORDER_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_QUEUE_LIST,
    SessionQueueListPayloadSchema,
    async (payload) => ({
      success: true,
      data: { queues: await getSessionQueueService().listQueue(payload?.instanceId) },
    }),
    'SESSION_QUEUE_LIST_FAILED',
  );

  register(
    IPC_CHANNELS.SESSION_QUEUE_PROMOTE,
    SessionQueuePromotePayloadSchema,
    async (payload) => ({
      success: true,
      data: await getSessionQueueService().promoteQueuedMessage(payload.admissionId),
    }),
    'SESSION_QUEUE_PROMOTE_FAILED',
  );
}
