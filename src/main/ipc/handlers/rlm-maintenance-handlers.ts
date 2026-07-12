import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  RlmMaintenanceRequestSchema,
  RlmStorageHealthRequestSchema,
} from '@contracts/schemas/rlm-maintenance';
import type { WindowManager } from '../../window-manager';
import type { RlmStorageMaintenanceService } from '../../rlm/rlm-storage-maintenance';
import type { RlmMaintenanceProgress } from '../../../shared/types/rlm-maintenance.types';
import { validatedHandler } from '../validated-handler';

export function registerRlmMaintenanceHandlers(dependencies: {
  service: RlmStorageMaintenanceService;
  windowManager: WindowManager;
}): void {
  const { service, windowManager } = dependencies;

  ipcMain.handle(
    IPC_CHANNELS.RLM_STORAGE_GET_HEALTH,
    validatedHandler(IPC_CHANNELS.RLM_STORAGE_GET_HEALTH, RlmStorageHealthRequestSchema, async () => ({
      success: true,
      data: service.getHealth(),
    })),
  );
  ipcMain.handle(
    IPC_CHANNELS.RLM_STORAGE_PREVIEW_MAINTENANCE,
    validatedHandler(IPC_CHANNELS.RLM_STORAGE_PREVIEW_MAINTENANCE, RlmMaintenanceRequestSchema, async (request) => ({
      success: true,
      data: service.preview(request),
    })),
  );
  ipcMain.handle(
    IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE,
    validatedHandler(IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE, RlmMaintenanceRequestSchema, async (request) => ({
      success: true,
      data: await service.run(request),
    })),
  );
  ipcMain.handle(
    IPC_CHANNELS.RLM_STORAGE_GET_MAINTENANCE_STATUS,
    validatedHandler(IPC_CHANNELS.RLM_STORAGE_GET_MAINTENANCE_STATUS, RlmStorageHealthRequestSchema, async () => ({
      success: true,
      data: service.getStatus(),
    })),
  );

  service.on('progress', (progress: RlmMaintenanceProgress) => {
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_STORAGE_MAINTENANCE_PROGRESS, progress);
  });
}
