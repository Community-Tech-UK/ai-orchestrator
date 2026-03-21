/**
 * Channel IPC Handlers
 * Handles Discord/WhatsApp channel connection, messaging, and access policy management
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
} from '../../../shared/validation/ipc-schemas';
import {
  ChannelConnectPayloadSchema,
  ChannelDisconnectPayloadSchema,
  ChannelGetStatusPayloadSchema,
  ChannelGetMessagesPayloadSchema,
  ChannelSendMessagePayloadSchema,
  ChannelPairSenderPayloadSchema,
  ChannelGetAccessPolicyPayloadSchema,
  ChannelSetAccessPolicyPayloadSchema,
} from '../../../shared/validation/channel-schemas';
import { getChannelManager, getChannelPersistence } from '../../channels';

export function registerChannelHandlers(): void {
  // ============================================
  // Channel Connection
  // ============================================

  // Connect to a channel platform
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_CONNECT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelConnectPayloadSchema, payload, 'CHANNEL_CONNECT');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        await adapter.connect({
          platform: validated.platform,
          token: validated.token,
          allowedSenders: [],
          allowedChats: [],
        });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_CONNECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Disconnect from a channel platform
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_DISCONNECT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelDisconnectPayloadSchema, payload, 'CHANNEL_DISCONNECT');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        await adapter.disconnect();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_NOT_CONNECTED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Channel Status
  // ============================================

  // Get status for a platform or all platforms
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelGetStatusPayloadSchema, payload, 'CHANNEL_GET_STATUS');
        const manager = getChannelManager();
        if (validated?.platform) {
          const adapter = manager.getAdapter(validated.platform);
          const status = adapter ? adapter.status : 'disconnected';
          return { success: true, data: { platform: validated.platform, status } };
        }
        // Return all statuses
        const allStatuses = manager.getAllStatuses();
        const data: Record<string, string> = {};
        for (const [platform, status] of allStatuses) {
          data[platform] = status;
        }
        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_NOT_CONNECTED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Channel Messages
  // ============================================

  // Get persisted messages for a chat
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_MESSAGES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelGetMessagesPayloadSchema, payload, 'CHANNEL_GET_MESSAGES');
        const messages = getChannelPersistence().getMessages(
          validated.platform,
          validated.chatId,
          { limit: validated.limit, before: validated.before }
        );
        return { success: true, data: messages };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_NOT_CONNECTED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Send a message via a channel platform
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_SEND_MESSAGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelSendMessagePayloadSchema, payload, 'CHANNEL_SEND_MESSAGE');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        const sent = await adapter.sendMessage(
          validated.chatId,
          validated.content,
          validated.replyTo ? { replyTo: validated.replyTo } : undefined
        );
        return { success: true, data: sent };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_SEND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Pairing
  // ============================================

  // Pair a sender via a pairing code
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_PAIR_SENDER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelPairSenderPayloadSchema, payload, 'CHANNEL_PAIR_SENDER');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        const paired = await adapter.pairSender(validated.code);
        return { success: true, data: paired };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_PAIR_INVALID',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Access Policy
  // ============================================

  // Get access policy for a platform
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_ACCESS_POLICY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelGetAccessPolicyPayloadSchema, payload, 'CHANNEL_GET_ACCESS_POLICY');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        const policy = adapter.getAccessPolicy();
        return { success: true, data: policy };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_UNAUTHORIZED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set access policy for a platform
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_SET_ACCESS_POLICY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ChannelSetAccessPolicyPayloadSchema, payload, 'CHANNEL_SET_ACCESS_POLICY');
        const adapter = getChannelManager().getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: {
              code: 'CHANNEL_ADAPTER_UNAVAILABLE',
              message: `No adapter registered for platform: ${validated.platform}`,
              timestamp: Date.now()
            }
          };
        }
        const currentPolicy = adapter.getAccessPolicy();
        adapter.setAccessPolicy({
          ...currentPolicy,
          mode: validated.mode,
        });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANNEL_UNAUTHORIZED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
