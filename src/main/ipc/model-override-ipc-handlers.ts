import { app, ipcMain } from 'electron';
import { z } from 'zod';
import { validateIpcPayload } from '@contracts/schemas/common';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getCatalogOverrideSource } from '../providers/catalog-override-source';

const ModelSetOverridePayloadSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(512),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ModelRemoveOverridePayloadSchema = z.object({
  provider: z.string().trim().min(1).max(128).optional(),
  modelId: z.string().trim().min(1).max(512),
}).strict();

export function registerModelOverrideHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MODEL_SET_OVERRIDE, async (_event, payload: unknown) => {
    try {
      const validated = validateIpcPayload(
        ModelSetOverridePayloadSchema,
        payload,
        'MODEL_SET_OVERRIDE',
      );
      const source = getCatalogOverrideSource();
      await source.ensureLocalStarted(app.getPath('userData'));
      const entry = await source.setLocalOverrideModel(
        validated.provider,
        validated.modelId,
        validated.config ?? {},
      );
      return { success: true, data: entry };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'MODEL_SET_OVERRIDE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.MODEL_REMOVE_OVERRIDE, async (_event, payload: unknown) => {
    try {
      const validated = validateIpcPayload(
        ModelRemoveOverridePayloadSchema,
        payload,
        'MODEL_REMOVE_OVERRIDE',
      );
      const source = getCatalogOverrideSource();
      await source.ensureLocalStarted(app.getPath('userData'));
      const removed = await source.removeLocalOverrideModel(
        validated.provider,
        validated.modelId,
      );
      return { success: true, data: { removed } };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'MODEL_REMOVE_OVERRIDE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      };
    }
  });
}
