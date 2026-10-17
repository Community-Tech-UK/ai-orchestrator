/**
 * Operator switch for the macOS signal fence (`signal-fence.ts`).
 *
 * `providerSignalFenceEnabled` is read at spawn time, so turning it off
 * affects sessions started or restarted afterwards. The per-session override
 * lives in `instance/lifecycle/signal-fence-scoping.ts`; the fence applies only
 * when both allow it.
 *
 * The settings manager is required lazily: adapters also run in worker
 * contexts that cannot load Electron. Any failure to read the setting keeps
 * the fence ON.
 */
import type { AppSettings } from '../../shared/types/settings.types';

const SETTING_KEY = 'providerSignalFenceEnabled' satisfies keyof AppSettings;
let readerOverride: (() => boolean) | null = null;

export function isSignalFenceSettingEnabled(): boolean {
  if (readerOverride) return readerOverride();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingsManager } = require('../core/config/settings-manager') as {
      getSettingsManager: () => { get: (key: string) => unknown };
    };
    return getSettingsManager().get(SETTING_KEY) !== false;
  } catch {
    return true;
  }
}

/** Tests cannot mock the lazy require; they set the switch here instead. */
export function _setSignalFenceSettingForTesting(enabled: boolean | null): void {
  readerOverride = enabled === null ? null : () => enabled;
}
