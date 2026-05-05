import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  OperatorCancelRunPayloadSchema,
  OperatorGetRunPayloadSchema,
  OperatorGetThreadPayloadSchema,
  OperatorListProjectsPayloadSchema,
  OperatorListRunsPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorRetryRunPayloadSchema,
  OperatorSendMessagePayloadSchema,
} from '@contracts/schemas/operator';
import { getOperatorEngine } from '../../operator';

export function registerOperatorHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.OPERATOR_GET_THREAD, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      validateIpcPayload(OperatorGetThreadPayloadSchema, payload ?? {}, 'OPERATOR_GET_THREAD');
      return { success: true, data: await getOperatorEngine().getThread() };
    } catch (error) {
      return operatorError(error, 'OPERATOR_GET_THREAD_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_SEND_MESSAGE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorSendMessagePayloadSchema,
        payload,
        'OPERATOR_SEND_MESSAGE'
      );
      return { success: true, data: await getOperatorEngine().sendMessage(validated) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_SEND_MESSAGE_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_LIST_RUNS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      validateIpcPayload(OperatorListRunsPayloadSchema, payload ?? {}, 'OPERATOR_LIST_RUNS');
      return { success: true, data: getOperatorEngine().listRuns() };
    } catch (error) {
      return operatorError(error, 'OPERATOR_LIST_RUNS_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_GET_RUN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorGetRunPayloadSchema,
        payload,
        'OPERATOR_GET_RUN'
      );
      return { success: true, data: getOperatorEngine().getRun(validated.runId) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_GET_RUN_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_CANCEL_RUN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorCancelRunPayloadSchema,
        payload,
        'OPERATOR_CANCEL_RUN'
      );
      return { success: true, data: await getOperatorEngine().cancelRun(validated.runId) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_CANCEL_RUN_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_RETRY_RUN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorRetryRunPayloadSchema,
        payload,
        'OPERATOR_RETRY_RUN'
      );
      return { success: true, data: await getOperatorEngine().retryRun(validated.runId) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_RETRY_RUN_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_RESCAN_PROJECTS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorRescanProjectsPayloadSchema,
        payload ?? {},
        'OPERATOR_RESCAN_PROJECTS'
      );
      return { success: true, data: await getOperatorEngine().rescanProjects(validated.roots) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_RESCAN_PROJECTS_FAILED');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPERATOR_LIST_PROJECTS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      validateIpcPayload(OperatorListProjectsPayloadSchema, payload ?? {}, 'OPERATOR_LIST_PROJECTS');
      return { success: true, data: getOperatorEngine().listProjects() };
    } catch (error) {
      return operatorError(error, 'OPERATOR_LIST_PROJECTS_FAILED');
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
