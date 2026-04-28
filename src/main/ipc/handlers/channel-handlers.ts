/**
 * Channel IPC Handlers
 *
 * Registers IPC handlers for Discord/WhatsApp channel management.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getLogger } from '../../logging/logger';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getChannelManager } from '../../channels';
import {
  ChannelConnectPayloadSchema,
  ChannelDisconnectPayloadSchema,
  ChannelGetMessagesPayloadSchema,
  ChannelSendMessagePayloadSchema,
  ChannelPairSenderPayloadSchema,
  ChannelSetAccessPolicyPayloadSchema,
  ChannelGetAccessPolicyPayloadSchema,
} from '../../../shared/validation/channel-schemas';
import { ChannelPersistence } from '../../channels/channel-persistence';
import { ChannelCredentialStore } from '../../channels/channel-credential-store';
import { ChannelAccessPolicyStore } from '../../channels/channel-access-policy-store';
import { restoreSavedAccessPolicy } from '../../channels/channel-policy-restore';
import { getRLMDatabase } from '../../persistence/rlm-database';

const logger = getLogger('ChannelHandlers');

function getCredentialStore(): ChannelCredentialStore {
  return new ChannelCredentialStore(getRLMDatabase().getRawDb());
}

function getAccessPolicyStore(): ChannelAccessPolicyStore {
  return new ChannelAccessPolicyStore(getRLMDatabase().getRawDb());
}

export function registerChannelHandlers(): void {
  const manager = getChannelManager();

  // Connect a channel adapter
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_CONNECT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelConnectPayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        const allowedSenders = restoreSavedAccessPolicy(
          adapter,
          validated.platform,
          getAccessPolicyStore(),
        );

        await adapter.connect({
          platform: validated.platform,
          token: validated.token,
          allowedSenders,
          allowedChats: [],
        });
        // Persist token so we can auto-reconnect on restart
        if (validated.token) {
          try {
            getCredentialStore().save(validated.platform, validated.token);
          } catch (err) {
            logger.warn('Failed to persist channel credential', { platform: validated.platform, error: String(err) });
          }
        }
        return { success: true, data: { platform: validated.platform, status: adapter.status } };
      } catch (error) {
        logger.error('CHANNEL_CONNECT failed', error instanceof Error ? error : new Error(String(error)));
        return {
          success: false,
          error: { code: 'CHANNEL_CONNECT_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Disconnect a channel adapter
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_DISCONNECT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelDisconnectPayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        // Remove saved credential so we don't auto-reconnect next time
        try {
          getCredentialStore().remove(validated.platform);
        } catch (err) {
          logger.warn('Failed to remove channel credential', { platform: validated.platform, error: String(err) });
        }
        await adapter.disconnect();
        return { success: true, data: { platform: validated.platform, status: 'disconnected' } };
      } catch (error) {
        logger.error('CHANNEL_DISCONNECT failed', error instanceof Error ? error : new Error(String(error)));
        return {
          success: false,
          error: { code: 'CHANNEL_DISCONNECT_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Get status of all channels
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const statuses = manager.getStatuses();
        return { success: true, data: statuses };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_STATUS_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Get messages for a chat
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_MESSAGES,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelGetMessagesPayloadSchema.parse(payload);
        const db = getRLMDatabase().getRawDb();
        const persistence = new ChannelPersistence(db);
        const messages = persistence.getMessages(validated.platform, validated.chatId, validated.limit, validated.before);
        return { success: true, data: messages };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_GET_MESSAGES_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Send a message via channel
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_SEND_MESSAGE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelSendMessagePayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        const sent = await adapter.sendMessage(validated.chatId, validated.content, {
          replyTo: validated.replyTo,
        });
        return { success: true, data: sent };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_SEND_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Pair a sender
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_PAIR_SENDER,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelPairSenderPayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        const paired = await adapter.pairSender(validated.code);
        // Persist the newly paired sender so it survives app restarts
        try {
          getAccessPolicyStore().addAllowedSender(validated.platform, paired.senderId);
        } catch (err) {
          logger.warn('Failed to persist paired sender', { platform: validated.platform, error: String(err) });
        }
        return { success: true, data: paired };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_PAIR_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Set access policy
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_SET_ACCESS_POLICY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelSetAccessPolicyPayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        const currentPolicy = adapter.getAccessPolicy();
        adapter.setAccessPolicy({ ...currentPolicy, mode: validated.mode });
        // Persist the updated policy so it survives app restarts
        try {
          getAccessPolicyStore().save(validated.platform, adapter.getAccessPolicy());
        } catch (err) {
          logger.warn('Failed to persist access policy', { platform: validated.platform, error: String(err) });
        }
        return { success: true, data: adapter.getAccessPolicy() };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_SET_ACCESS_POLICY_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  // Get access policy
  ipcMain.handle(
    IPC_CHANNELS.CHANNEL_GET_ACCESS_POLICY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = ChannelGetAccessPolicyPayloadSchema.parse(payload);
        const adapter = manager.getAdapter(validated.platform);
        if (!adapter) {
          return {
            success: false,
            error: { code: 'CHANNEL_ADAPTER_UNAVAILABLE', message: `No adapter registered for ${validated.platform}`, timestamp: Date.now() },
          };
        }
        return { success: true, data: adapter.getAccessPolicy() };
      } catch (error) {
        return {
          success: false,
          error: { code: 'CHANNEL_GET_ACCESS_POLICY_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    }
  );

  logger.info('Channel IPC handlers registered');
}
