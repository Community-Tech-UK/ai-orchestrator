import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  RlmMaintenancePreview,
  RlmMaintenanceProgress,
  RlmMaintenanceResult,
  RlmStorageHealth,
} from '../../shared/types/rlm-maintenance.types';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createRlmStorageMaintenanceDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    rlmStorageGetHealth: (): Promise<IpcResponse<RlmStorageHealth>> =>
      ipcRenderer.invoke(ch.RLM_STORAGE_GET_HEALTH, {}),

    rlmStoragePreviewMaintenance: (loopRunId?: string): Promise<IpcResponse<RlmMaintenancePreview>> =>
      ipcRenderer.invoke(ch.RLM_STORAGE_PREVIEW_MAINTENANCE, {
        ...(loopRunId ? { loopRunId } : {}),
      }),

    rlmStorageRunMaintenance: (loopRunId?: string): Promise<IpcResponse<RlmMaintenanceResult>> =>
      ipcRenderer.invoke(ch.RLM_STORAGE_RUN_MAINTENANCE, {
        ...(loopRunId ? { loopRunId } : {}),
      }),

    rlmStorageGetMaintenanceStatus: (): Promise<IpcResponse<RlmMaintenanceResult | null>> =>
      ipcRenderer.invoke(ch.RLM_STORAGE_GET_MAINTENANCE_STATUS, {}),

    onRlmStorageMaintenanceProgress: (
      callback: (progress: RlmMaintenanceProgress) => void,
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: RlmMaintenanceProgress) => callback(progress);
      ipcRenderer.on(ch.RLM_STORAGE_MAINTENANCE_PROGRESS, handler);
      return () => ipcRenderer.removeListener(ch.RLM_STORAGE_MAINTENANCE_PROGRESS, handler);
    },
  };
}
