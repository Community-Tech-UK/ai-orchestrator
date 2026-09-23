import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  browserExtensionQueueKeyForNode,
  type BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import { getBrowserExtensionTabStore } from './browser-extension-tab-store';
import {
  bindSecretObservationProtectionReader,
  resetSecretObservationStampForTesting,
} from './browser-secret-observation-stamp';

const logger = getLogger('BrowserSecretObservationProtection');

export {
  SECRET_OBSERVATION_PROTECTION_PAYLOAD_KEY,
  bindSecretObservationProtectionReader,
  isSecretObservationProtectionEnabled,
  stampSecretObservationProtection,
} from './browser-secret-observation-stamp';

export const SECRET_OBSERVATION_PROTECTION_SETTING_KEY =
  'browserSecretObservationProtectionEnabled';

let applyUnsubscribe: (() => void) | undefined;

export function resetSecretObservationProtectionReaderForTesting(): void {
  resetSecretObservationStampForTesting();
  applyUnsubscribe?.();
  applyUnsubscribe = undefined;
}

function readEnabledFromSettings(): boolean {
  try {
    return getSettingsManager().getAll().browserSecretObservationProtectionEnabled !== false;
  } catch (error) {
    logger.warn('Failed to read browserSecretObservationProtectionEnabled; protection stays on', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function queueKeysForApply(commandStore: BrowserExtensionCommandStore): string[] {
  const keys = new Set<string>(commandStore.listActiveQueueKeys());
  keys.add('local');
  try {
    for (const tab of getBrowserExtensionTabStore().listTabs()) {
      if (tab.nodeId) {
        keys.add(browserExtensionQueueKeyForNode(tab.nodeId));
      }
    }
  } catch {
    // Tab store may be uninitialised in tests; local + known queues are enough.
  }
  return [...keys];
}

export function applySecretObservationProtectionToQueues(
  commandStore: BrowserExtensionCommandStore,
): void {
  // The command store stamps the current setting onto every command.
  for (const queueKey of queueKeysForApply(commandStore)) {
    void commandStore.sendCommand({
      queueKey,
      command: 'report_inventory',
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      logger.warn('Could not push secret-observation protection to an extension queue', {
        queueKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function watchSecretObservationProtectionSetting(
  commandStore: BrowserExtensionCommandStore,
): void {
  applyUnsubscribe?.();
  bindSecretObservationProtectionReader(readEnabledFromSettings);
  let manager: ReturnType<typeof getSettingsManager>;
  try {
    manager = getSettingsManager();
  } catch {
    return;
  }
  const listener = (key: string): void => {
    if (key !== SECRET_OBSERVATION_PROTECTION_SETTING_KEY) {
      return;
    }
    applySecretObservationProtectionToQueues(commandStore);
  };
  manager.on('setting-changed', listener);
  applyUnsubscribe = () => manager.off('setting-changed', listener);
}
