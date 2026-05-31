/**
 * Multi-provider compare IPC handlers (backlog #11).
 *
 *   - compare:list-providers — which providers are installed/available
 *   - compare:run            — ask N providers the same prompt, return all answers
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { CompareRunPayloadSchema } from '@contracts/schemas/command';
import { getMultiProviderCompareService } from '../../compare/multi-provider-compare-service';

export function registerCompareHandlers(): void {
  const service = getMultiProviderCompareService();

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
}
