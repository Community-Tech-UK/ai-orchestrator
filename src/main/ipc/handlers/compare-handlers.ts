/**
 * Multi-provider compare IPC handlers (backlog #11) + WS-B6 Ask Council.
 *
 *   - compare:list-providers — which providers are installed/available
 *   - compare:run            — ask N providers the same prompt, await all answers
 *
 * WS-B6 progressive Council run channels (per-member cards, live updates,
 * cancellation, synthesis):
 *   - compare:start          — start a progressive run; returns immediately with queued members
 *   - compare:cancel         — cancel an in-flight run
 *   - compare:synthesize     — synthesize completed answers (consensus/debate/chosen provider)
 *   - compare:get-run        — fetch a run by id, or the latest run when no id is given (rehydrate)
 *   - compare:run-updated (event) — pushed after every member/synthesis state change
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CompareCancelPayloadSchema,
  CompareGetRunPayloadSchema,
  CompareRunPayloadSchema,
  CompareStartPayloadSchema,
  CompareSynthesizePayloadSchema,
} from '@contracts/schemas/command';
import { getMultiProviderCompareService } from '../../compare/multi-provider-compare-service';
import { getCouncilRunService } from '../../compare/council-run-service';
import type { WindowManager } from '../../window-manager';

export function registerCompareHandlers(deps: { windowManager: WindowManager }): void {
  const service = getMultiProviderCompareService();
  const councilRuns = getCouncilRunService();

  ipcMain.handle(IPC_CHANNELS.COMPARE_LIST_PROVIDERS, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: await service.listAvailableProviders() };
    } catch (error) {
      return {
        success: false,
        error: { code: 'COMPARE_LIST_FAILED', message: (error as Error).message, timestamp: Date.now() },
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.COMPARE_RUN,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CompareRunPayloadSchema, payload, 'COMPARE_RUN');
        const result = await service.compare(validated.prompt, validated.providers, {
          workingDirectory: validated.workingDirectory,
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: { code: 'COMPARE_RUN_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  // ────── WS-B6: progressive Council run + synthesis ──────

  councilRuns.on('run-updated', (run: unknown) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.COMPARE_RUN_UPDATED, run);
  });

  ipcMain.handle(
    IPC_CHANNELS.COMPARE_START,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CompareStartPayloadSchema, payload, 'COMPARE_START');
        const run = councilRuns.startRun(validated.prompt, validated.providers, {
          workingDirectory: validated.workingDirectory,
        });
        return { success: true, data: run };
      } catch (error) {
        return {
          success: false,
          error: { code: 'COMPARE_START_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.COMPARE_CANCEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CompareCancelPayloadSchema, payload, 'COMPARE_CANCEL');
        const run = councilRuns.cancelRun(validated.runId);
        return { success: true, data: run };
      } catch (error) {
        return {
          success: false,
          error: { code: 'COMPARE_CANCEL_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.COMPARE_SYNTHESIZE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CompareSynthesizePayloadSchema, payload, 'COMPARE_SYNTHESIZE');
        const run = await councilRuns.synthesizeRun(validated.runId, validated.method);
        return { success: true, data: run };
      } catch (error) {
        return {
          success: false,
          error: { code: 'COMPARE_SYNTHESIZE_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.COMPARE_GET_RUN,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CompareGetRunPayloadSchema, payload, 'COMPARE_GET_RUN');
        const run = councilRuns.getRun(validated.runId);
        return { success: true, data: run };
      } catch (error) {
        return {
          success: false,
          error: { code: 'COMPARE_GET_RUN_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );
}
