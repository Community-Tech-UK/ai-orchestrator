import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  OperatorGetThreadPayloadSchema,
  OperatorListProjectsPayloadSchema,
  OperatorListRunsPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorRunIdPayloadSchema,
  OperatorSendMessagePayloadSchema,
} from '@contracts/schemas/operator';
import {
  OperatorRunStore,
  getOperatorDatabase,
  getOperatorThreadService,
  getProjectRegistry,
} from '../../operator';

export function registerOperatorHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.OPERATOR_GET_THREAD, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      validateIpcPayload(
        OperatorGetThreadPayloadSchema,
        payload ?? {},
        'OPERATOR_GET_THREAD',
      );
      return { success: true, data: await getOperatorThreadService().getThread() };
    } catch (error) {
      return operatorError(error, 'OPERATOR_GET_THREAD_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_SEND_MESSAGE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorSendMessagePayloadSchema,
        payload,
        'OPERATOR_SEND_MESSAGE',
      );
      return { success: true, data: await getOperatorThreadService().sendMessage(validated) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_SEND_MESSAGE_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_LIST_PROJECTS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorListProjectsPayloadSchema,
        payload ?? {},
        'OPERATOR_LIST_PROJECTS',
      );
      return { success: true, data: getProjectRegistry().listProjects(validated ?? {}) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_LIST_PROJECTS_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_RESCAN_PROJECTS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorRescanProjectsPayloadSchema,
        payload ?? {},
        'OPERATOR_RESCAN_PROJECTS',
      );
      return { success: true, data: await getProjectRegistry().refreshProjects(validated ?? {}) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_RESCAN_PROJECTS_FAILED');
    }
  });

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
