import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ChatCreatePayloadSchema,
  ChatIdPayloadSchema,
  ChatListPayloadSchema,
  ChatRenamePayloadSchema,
  ChatSendMessagePayloadSchema,
  ChatSetCwdPayloadSchema,
  ChatSetModelPayloadSchema,
  ChatSetProviderPayloadSchema,
  ChatSetYoloPayloadSchema,
} from '@contracts/schemas/chat';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getChatService } from '../../chats';

let chatEventForwardingRegistered = false;

export function registerChatHandlers(deps: { instanceManager: InstanceManager }): void {
  const service = getChatService({ instanceManager: deps.instanceManager });
  service.initialize();
  registerChatEventForwarding(deps.instanceManager);

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatListPayloadSchema, payload ?? {}, 'CHAT_LIST');
      return { success: true, data: service.listChats(validated ?? {}) };
    } catch (error) {
      return chatError(error, 'CHAT_LIST_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_GET, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatIdPayloadSchema, payload, 'CHAT_GET');
      return { success: true, data: service.getChat(validated.chatId) };
    } catch (error) {
      return chatError(error, 'CHAT_GET_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CREATE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatCreatePayloadSchema, payload, 'CHAT_CREATE');
      return { success: true, data: await service.createChat(validated) };
    } catch (error) {
      return chatError(error, 'CHAT_CREATE_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_RENAME, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatRenamePayloadSchema, payload, 'CHAT_RENAME');
      return { success: true, data: service.renameChat(validated.chatId, validated.name) };
    } catch (error) {
      return chatError(error, 'CHAT_RENAME_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_ARCHIVE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatIdPayloadSchema, payload, 'CHAT_ARCHIVE');
      return { success: true, data: service.archiveChat(validated.chatId) };
    } catch (error) {
      return chatError(error, 'CHAT_ARCHIVE_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_CWD, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatSetCwdPayloadSchema, payload, 'CHAT_SET_CWD');
      return { success: true, data: await service.setCwd(validated.chatId, validated.cwd) };
    } catch (error) {
      return chatError(error, 'CHAT_SET_CWD_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_PROVIDER, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatSetProviderPayloadSchema, payload, 'CHAT_SET_PROVIDER');
      return { success: true, data: service.setProvider(validated.chatId, validated.provider) };
    } catch (error) {
      return chatError(error, 'CHAT_SET_PROVIDER_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_MODEL, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatSetModelPayloadSchema, payload, 'CHAT_SET_MODEL');
      return { success: true, data: service.setModel(validated.chatId, validated.model) };
    } catch (error) {
      return chatError(error, 'CHAT_SET_MODEL_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_YOLO, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatSetYoloPayloadSchema, payload, 'CHAT_SET_YOLO');
      return { success: true, data: service.setYolo(validated.chatId, validated.yolo) };
    } catch (error) {
      return chatError(error, 'CHAT_SET_YOLO_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SEND_MESSAGE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(ChatSendMessagePayloadSchema, payload, 'CHAT_SEND_MESSAGE');
      return { success: true, data: await service.sendMessage(validated) };
    } catch (error) {
      return chatError(error, 'CHAT_SEND_MESSAGE_FAILED');
    }
  });
}

function registerChatEventForwarding(instanceManager: InstanceManager): void {
  if (chatEventForwardingRegistered) {
    return;
  }
  chatEventForwardingRegistered = true;
  const service = getChatService({ instanceManager });
  service.events.on('chat:event', (payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(IPC_CHANNELS.CHAT_EVENT, payload);
    }
  });
}

function chatError(error: unknown, fallbackCode: string): IpcResponse {
  return {
    success: false,
    error: {
      code: fallbackCode,
      message: error instanceof Error ? error.message : 'Chat request failed',
      timestamp: Date.now(),
    },
  };
}
