import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import { PauseSetManualPayloadSchema } from '@contracts/schemas/pause';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getVpnDetector } from '../../network/vpn-detector';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import type { WindowManager } from '../../window-manager';

export function registerPauseHandlers(deps: { windowManager: WindowManager }): void {
  const coordinator = getPauseCoordinator();

  coordinator.on('change', () => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.PAUSE_STATE_CHANGED, coordinator.toPayload());
  });

  ipcMain.handle(IPC_CHANNELS.PAUSE_GET_STATE, async (): Promise<IpcResponse> => ({
    success: true,
    data: coordinator.toPayload(),
  }));

  ipcMain.handle(
    IPC_CHANNELS.PAUSE_SET_MANUAL,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      try {
        const settings = getSettingsManager();
        if (!settings.get('pauseFeatureEnabled')) {
          return {
            success: false,
            error: {
              code: 'PAUSE_FEATURE_DISABLED',
              message: 'Pause feature is disabled',
              timestamp: Date.now(),
            },
          };
        }

        const validated = validateIpcPayload(
          PauseSetManualPayloadSchema,
          payload,
          'PAUSE_SET_MANUAL'
        );
        if (validated.paused) coordinator.addReason('user');
        else coordinator.removeReason('user');

        return { success: true, data: coordinator.toPayload() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PAUSE_SET_MANUAL_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PAUSE_DETECTOR_RECENT_EVENTS, async (): Promise<IpcResponse> => {
    try {
      if (!getSettingsManager().get('pauseFeatureEnabled')) {
        return { success: true, data: { events: [] } };
      }
      return { success: true, data: { events: getVpnDetector().recentEvents() } };
    } catch {
      return { success: true, data: { events: [] } };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PAUSE_DETECTOR_RESUME_AFTER_ERROR,
    async (): Promise<IpcResponse> => {
      coordinator.removeReason('detector-error');
      return { success: true, data: coordinator.toPayload() };
    }
  );
}
