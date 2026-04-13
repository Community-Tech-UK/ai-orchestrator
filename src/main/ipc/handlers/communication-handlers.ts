/**
 * Cross-Instance Communication IPC Handlers
 *
 * Registers IPC handlers for bridge and message management between instances.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { getLogger } from '../../logging/logger';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getCrossInstanceComm } from '../../communication/cross-instance-comm';

const logger = getLogger('CommunicationHandlers');

const InstanceIdSchema = z.string().min(1).max(200);
const BridgeIdSchema = z.string().min(1).max(200);

const CommCreateBridgePayloadSchema = z.object({
  name: z.string().min(1).max(500),
  sourceInstanceId: InstanceIdSchema,
  targetInstanceId: InstanceIdSchema,
});

const CommDeleteBridgePayloadSchema = z.object({
  bridgeId: BridgeIdSchema,
});

const CommSendMessagePayloadSchema = z.object({
  bridgeId: BridgeIdSchema,
  fromInstanceId: InstanceIdSchema,
  content: z.string().max(500_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CommGetMessagesPayloadSchema = z.object({
  bridgeId: BridgeIdSchema,
  limit: z.number().int().min(1).max(10_000).optional(),
});

const CommSubscribePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  bridgeId: BridgeIdSchema,
});

function validationError(err: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : (err as Error).message,
      timestamp: Date.now(),
    },
  };
}

export function registerCommunicationHandlers(): void {
  const comm = getCrossInstanceComm();

  // ============================================
  // Bridge Management
  // ============================================

  // Create a new communication bridge between two instances
  ipcMain.handle(
    IPC_CHANNELS.COMM_CREATE_BRIDGE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      let validated;
      try {
        validated = CommCreateBridgePayloadSchema.parse(payload);
      } catch (err) {
        return validationError(err);
      }

      try {
        const bridge = comm.createBridge(
          validated.name,
          validated.sourceInstanceId,
          validated.targetInstanceId,
        );
        logger.info('COMM_CREATE_BRIDGE handled', { bridgeId: bridge.id });
        return { success: true, data: bridge };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CREATE_BRIDGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Delete an existing communication bridge
  ipcMain.handle(
    IPC_CHANNELS.COMM_DELETE_BRIDGE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      let validated;
      try {
        validated = CommDeleteBridgePayloadSchema.parse(payload);
      } catch (err) {
        return validationError(err);
      }

      try {
        const deleted = comm.deleteBridge(validated.bridgeId);
        return { success: true, data: deleted };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DELETE_BRIDGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // List all bridges
  ipcMain.handle(
    IPC_CHANNELS.COMM_GET_BRIDGES,
    async (): Promise<IpcResponse> => {
      try {
        const bridges = comm.getBridges();

        return {
          success: true,
          data: bridges,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'GET_BRIDGES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Messaging
  // ============================================

  // Send a message over a bridge
  ipcMain.handle(
    IPC_CHANNELS.COMM_SEND_MESSAGE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      let validated;
      try {
        validated = CommSendMessagePayloadSchema.parse(payload);
      } catch (err) {
        return validationError(err);
      }

      try {
        const message = comm.sendMessage(
          validated.bridgeId,
          validated.fromInstanceId,
          validated.content,
          validated.metadata,
        );
        return { success: true, data: message };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEND_MESSAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Retrieve messages for a bridge
  ipcMain.handle(
    IPC_CHANNELS.COMM_GET_MESSAGES,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      let validated;
      try {
        validated = CommGetMessagesPayloadSchema.parse(payload);
      } catch (err) {
        return validationError(err);
      }

      try {
        const messages = comm.getMessages(validated.bridgeId, validated.limit);
        return { success: true, data: messages };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'GET_MESSAGES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Subscriptions
  // ============================================

  // Subscribe an instance to a bridge
  ipcMain.handle(
    IPC_CHANNELS.COMM_SUBSCRIBE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      let validated;
      try {
        validated = CommSubscribePayloadSchema.parse(payload);
      } catch (err) {
        return validationError(err);
      }

      try {
        const subscribed = comm.subscribe(validated.instanceId, validated.bridgeId);
        return { success: true, data: subscribed };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUBSCRIBE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Auth token
  // ============================================

  // Generate a one-time auth token (UUID) for inter-instance communication
  ipcMain.handle(
    IPC_CHANNELS.COMM_REQUEST_TOKEN,
    async (): Promise<IpcResponse> => {
      try {
        const token = crypto.randomUUID();

        return {
          success: true,
          data: { token },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REQUEST_TOKEN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );
}
