/**
 * Durable renderer send-queue IPC handlers (WS-A1 Phase B).
 *
 * Mirrors session-admission-handlers.ts's pattern: one validatedHandler per
 * channel, registered behind the same trusted-sender check used across
 * session-handlers.ts. See session-queue-service.ts for the durable-queue
 * design (SessionAdmissionStore is the shared storage authority).
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
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
import { validatedHandler } from '../validated-handler';
import type { FileAttachment } from '../../../shared/types/instance.types';

export interface SessionQueueHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

function registerTrusted(
  channel: string,
  deps: SessionQueueHandlersDeps,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, (event, ...args): IpcResponse | Promise<IpcResponse> => {
    const trustError = deps.ensureTrustedSender?.(event, channel);
    return trustError ?? (listener(event, ...args) as Promise<IpcResponse>);
  });
}

export function registerSessionQueueHandlers(deps: SessionQueueHandlersDeps): void {
  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_ENQUEUE,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_ENQUEUE,
      SessionQueueEnqueuePayloadSchema,
      async (payload) => ({
        success: true,
        data: await getSessionQueueService().enqueueUserMessage({
          ...payload,
          attachments: payload.attachments as FileAttachment[] | undefined,
        }),
      }),
      { errorCode: 'SESSION_QUEUE_ENQUEUE_FAILED' },
    ),
  );

  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_UPDATE,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_UPDATE,
      SessionQueueUpdatePayloadSchema,
      async (payload) => ({
        success: true,
        data: await getSessionQueueService().updateQueuedMessage(payload.admissionId, {
          ...payload,
          attachments: payload.attachments as FileAttachment[] | undefined,
        }),
      }),
      { errorCode: 'SESSION_QUEUE_UPDATE_FAILED' },
    ),
  );

  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_CANCEL,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_CANCEL,
      SessionQueueCancelPayloadSchema,
      async (payload) => ({ success: true, data: { cancelled: getSessionQueueService().cancelQueuedMessage(payload.admissionId) } }),
      { errorCode: 'SESSION_QUEUE_CANCEL_FAILED' },
    ),
  );

  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_REORDER,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_REORDER,
      SessionQueueReorderPayloadSchema,
      async (payload) => {
        getSessionQueueService().reorderQueue(payload.instanceId, payload.orderedIds);
        return { success: true };
      },
      { errorCode: 'SESSION_QUEUE_REORDER_FAILED' },
    ),
  );

  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_LIST,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_LIST,
      SessionQueueListPayloadSchema,
      async (payload) => ({ success: true, data: { queues: await getSessionQueueService().listQueue(payload?.instanceId) } }),
      { errorCode: 'SESSION_QUEUE_LIST_FAILED' },
    ),
  );

  registerTrusted(
    IPC_CHANNELS.SESSION_QUEUE_PROMOTE,
    deps,
    validatedHandler(
      IPC_CHANNELS.SESSION_QUEUE_PROMOTE,
      SessionQueuePromotePayloadSchema,
      async (payload) => ({ success: true, data: await getSessionQueueService().promoteQueuedMessage(payload.admissionId) }),
      { errorCode: 'SESSION_QUEUE_PROMOTE_FAILED' },
    ),
  );
}
