import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { GlobalPauseHoldSchema, GlobalPauseRestartSchema, GlobalPausePickUpSchema } from '@contracts/schemas/global-pause';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getGlobalPauseService, type GlobalPauseService } from '../../global-pause/global-pause-service';
import type { WindowManager } from '../../window-manager';

export function registerGlobalPauseHandlers(deps: {
  windowManager: WindowManager;
  ensureTrustedSender: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
  service?: GlobalPauseService;
}): void {
  const service = deps.service ?? getGlobalPauseService();
  service.on('state-changed', state => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.GLOBAL_PAUSE_STATE_CHANGED, state);
  });

  const register = (channel: string, run: (payload: unknown) => unknown | Promise<unknown>) => {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResponse> => {
      const denied = deps.ensureTrustedSender(event, channel);
      if (denied) return denied;
      try {
        await run(payload);
        return { success: true, data: service.getState() };
      } catch (error) {
        return { success: false, error: {
          code: 'GLOBAL_PAUSE_FAILED', message: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
        } };
      }
    });
  };
  register(IPC_CHANNELS.GLOBAL_PAUSE_GET_STATE, () => undefined);
  register(IPC_CHANNELS.GLOBAL_PAUSE_HOLD, payload => service.hold(GlobalPauseHoldSchema.parse(payload ?? {}).reason));
  register(IPC_CHANNELS.GLOBAL_PAUSE_RELEASE, () => service.release());
  register(IPC_CHANNELS.GLOBAL_PAUSE_RESTART, payload => service.pauseForRestart(GlobalPauseRestartSchema.parse(payload)));
  register(IPC_CHANNELS.GLOBAL_PAUSE_SKIP_NOTES, () => service.skipNotes());
  register(IPC_CHANNELS.GLOBAL_PAUSE_RESUME, () => service.resume());
  register(IPC_CHANNELS.GLOBAL_PAUSE_DISCARD, () => service.discard());
  register(IPC_CHANNELS.GLOBAL_PAUSE_PICK_UP, payload => service.manualInput(GlobalPausePickUpSchema.parse(payload).instanceId));
  register(IPC_CHANNELS.GLOBAL_PAUSE_QUIT, () => {
    if (service.getState().phase !== 'ready') throw new Error('Wait until Harness is safe to restart.');
    // Let the invoke response reach the renderer before normal shutdown begins.
    setImmediate(() => app.quit());
  });
}
