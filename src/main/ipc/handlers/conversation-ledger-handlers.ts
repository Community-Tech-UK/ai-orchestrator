/**
 * Minimal IPC handlers for the provider-native conversation ledger.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ConversationLedgerDiscoverPayloadSchema,
  ConversationLedgerListPayloadSchema,
  ConversationLedgerSendTurnPayloadSchema,
  ConversationLedgerStartPayloadSchema,
  ConversationLedgerThreadIdPayloadSchema,
} from '@contracts/schemas/conversation-ledger';
import { ConversationLedgerServiceError, getConversationLedgerService } from '../../conversation-ledger';

export function registerConversationLedgerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_LIST, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerListPayloadSchema,
        payload ?? {},
        'CONVERSATION_LEDGER_LIST'
      );
      return { success: true, data: getConversationLedgerService().listConversations(validated) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_LIST_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_GET, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerThreadIdPayloadSchema,
        payload,
        'CONVERSATION_LEDGER_GET'
      );
      return { success: true, data: getConversationLedgerService().getConversation(validated.threadId) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_GET_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_DISCOVER, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerDiscoverPayloadSchema,
        payload ?? {},
        'CONVERSATION_LEDGER_DISCOVER'
      );
      return { success: true, data: await getConversationLedgerService().discoverNativeConversations(validated) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_DISCOVER_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_RECONCILE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerThreadIdPayloadSchema,
        payload,
        'CONVERSATION_LEDGER_RECONCILE'
      );
      return { success: true, data: await getConversationLedgerService().reconcileConversation(validated.threadId) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_RECONCILE_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_START, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerStartPayloadSchema,
        payload,
        'CONVERSATION_LEDGER_START'
      );
      return { success: true, data: await getConversationLedgerService().startConversation(validated) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_START_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LEDGER_SEND_TURN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        ConversationLedgerSendTurnPayloadSchema,
        payload,
        'CONVERSATION_LEDGER_SEND_TURN'
      );
      const { threadId, ...request } = validated;
      return { success: true, data: await getConversationLedgerService().sendTurn(threadId, request) };
    } catch (error) {
      return conversationLedgerError(error, 'CONVERSATION_LEDGER_SEND_TURN_FAILED');
    }
  });
}

function conversationLedgerError(error: unknown, fallbackCode: string): IpcResponse {
  return {
    success: false,
    error: {
      code: error instanceof ConversationLedgerServiceError ? error.code : fallbackCode,
      message: error instanceof Error ? error.message : 'Conversation ledger request failed',
      timestamp: Date.now(),
    },
  };
}
