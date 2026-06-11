import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { AppSettings } from '../../../shared/types/settings.types';
import type { WindowManager } from '../../window-manager';

export type SettingsChangedPayload =
  | { key: keyof AppSettings | '__imported__'; value: unknown }
  | { settings: AppSettings };

export function broadcastSettingsChanged(
  windowManager: Pick<WindowManager, 'sendToRenderer'>,
  payload: SettingsChangedPayload,
): void {
  windowManager.sendToRenderer(IPC_CHANNELS.SETTINGS_CHANGED, payload);
}
