import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { RemoteObserverStartPayloadSchema } from '@contracts/schemas/settings';
import { getRemoteObserverServer } from '../../remote/observer-server';

export function registerRemoteObserverHandlers(): void {
  const observer = getRemoteObserverServer();

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_OBSERVER_GET_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: observer.getStatus(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_OBSERVER_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_OBSERVER_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteObserverStartPayloadSchema,
          payload,
          'REMOTE_OBSERVER_START',
        );
        return {
          success: true,
          data: await observer.start(validated.host, validated.port),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_OBSERVER_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_OBSERVER_STOP,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await observer.stop(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_OBSERVER_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_OBSERVER_ROTATE_TOKEN,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await observer.rotateToken(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_OBSERVER_ROTATE_TOKEN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
