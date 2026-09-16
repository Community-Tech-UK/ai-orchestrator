/**
 * IPC handlers for user-initiated cross-session messaging from the renderer:
 * sending a message to another live instance, listing which instances are
 * currently addressable, and toggling this instance's own consent to receive
 * such messages.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CrossSessionMessageSendPayloadSchema,
  InstanceListMessageableSessionsPayloadSchema,
  InstanceToggleAllowIncomingSessionMessagesPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getCrossSessionMessagingService } from '../../instance/cross-session-messaging';

export function registerInstanceCrossSessionMessagingHandlers(
  instanceManager: InstanceManager,
): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CrossSessionMessageSendPayloadSchema,
          payload,
          'INSTANCE_SEND_CROSS_SESSION_MESSAGE',
        );
        // The discriminated result (delivered/rejected/not-found/ambiguous) is
        // the payload itself, not a success/failure split — the renderer needs
        // to show *why* a send was rejected, not just that it failed.
        const result = await getCrossSessionMessagingService().sendMessage(validated);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CROSS_SESSION_MESSAGE_SEND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_LIST_MESSAGEABLE_SESSIONS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceListMessageableSessionsPayloadSchema,
          payload,
          'INSTANCE_LIST_MESSAGEABLE_SESSIONS',
        );
        const result = getCrossSessionMessagingService().listMessageableSessions(
          validated.sourceInstanceId,
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LIST_MESSAGEABLE_SESSIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceToggleAllowIncomingSessionMessagesPayloadSchema,
          payload,
          'INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES',
        );
        instanceManager.setAllowIncomingSessionMessages(validated.instanceId, validated.allow);
        const instance = instanceManager.getInstance(validated.instanceId);
        return { success: true, data: instance ? instanceManager.serializeForIpc(instance) : undefined };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
