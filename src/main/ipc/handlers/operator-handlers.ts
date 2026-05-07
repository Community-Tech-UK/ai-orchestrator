import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  OperatorListRunsPayloadSchema,
  OperatorRunIdPayloadSchema,
} from '@contracts/schemas/operator';
import {
  OperatorRunStore,
  getOperatorEventBus,
  getOperatorDatabase,
  getOperatorRunRunner,
} from '../../operator';

let operatorEventForwardingRegistered = false;

export function registerOperatorHandlers(): void {
  registerOperatorEventForwarding();

  ipcMain.handle(IPC_CHANNELS.OPERATOR_LIST_RUNS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorListRunsPayloadSchema,
        payload ?? {},
        'OPERATOR_LIST_RUNS',
      );
      const store = new OperatorRunStore(getOperatorDatabase().db);
      return { success: true, data: store.listRuns(validated ?? {}) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_LIST_RUNS_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_GET_RUN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorRunIdPayloadSchema,
        payload,
        'OPERATOR_GET_RUN',
      );
      const store = new OperatorRunStore(getOperatorDatabase().db);
      return { success: true, data: store.getRunGraph(validated.runId) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_GET_RUN_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_CANCEL_RUN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorRunIdPayloadSchema,
        payload,
        'OPERATOR_CANCEL_RUN',
      );
      return { success: true, data: getOperatorRunRunner().cancel(validated.runId) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_CANCEL_RUN_FAILED');
    }
  });
}

function registerOperatorEventForwarding(): void {
  if (operatorEventForwardingRegistered) {
    return;
  }
  operatorEventForwardingRegistered = true;
  getOperatorEventBus().subscribe((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(IPC_CHANNELS.OPERATOR_EVENT, payload);
    }
  });
}

function operatorError(error: unknown, fallbackCode: string): IpcResponse {
  return {
    success: false,
    error: {
      code: fallbackCode,
      message: error instanceof Error ? error.message : 'Operator request failed',
      timestamp: Date.now(),
    },
  };
}
