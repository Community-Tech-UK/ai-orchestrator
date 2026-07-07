import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  OperatorListRunsPayloadSchema,
  OperatorListProjectsPayloadSchema,
  OperatorPlanProjectVerificationPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorResolveProjectPayloadSchema,
  OperatorRunIdPayloadSchema,
} from '@contracts/schemas/operator';
import {
  OperatorRunStore,
  getOperatorEventBus,
  getOperatorDatabase,
  getOperatorRunRunner,
  getProjectRegistry,
  planProjectVerification,
} from '../../operator';
import { getMainEventBus } from '../../event-bus/main-event-bus';

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

  ipcMain.handle(IPC_CHANNELS.OPERATOR_RESOLVE_PROJECT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        OperatorResolveProjectPayloadSchema,
        payload,
        'OPERATOR_RESOLVE_PROJECT',
      );
      return { success: true, data: getProjectRegistry().resolveProject(validated.query) };
    } catch (error) {
      return operatorError(error, 'OPERATOR_RESOLVE_PROJECT_FAILED');
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.OPERATOR_PLAN_PROJECT_VERIFICATION,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          OperatorPlanProjectVerificationPayloadSchema,
          payload,
          'OPERATOR_PLAN_PROJECT_VERIFICATION',
        );
        return { success: true, data: await planProjectVerification(validated.projectPath) };
      } catch (error) {
        return operatorError(error, 'OPERATOR_PLAN_PROJECT_VERIFICATION_FAILED');
      }
    },
  );
}

function registerOperatorEventForwarding(): void {
  if (operatorEventForwardingRegistered) {
    return;
  }
  operatorEventForwardingRegistered = true;
  const eventBus = getMainEventBus();
  getOperatorEventBus().subscribe((payload) => {
    eventBus.emitRendererEvent(IPC_CHANNELS.OPERATOR_EVENT, payload);
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
