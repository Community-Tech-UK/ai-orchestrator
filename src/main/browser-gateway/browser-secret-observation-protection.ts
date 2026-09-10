import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  browserExtensionQueueKeyForNode,
  type BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import { getBrowserExtensionTabStore } from './browser-extension-tab-store';

const logger = getLogger('BrowserSecretObservationProtection');

export const SECRET_OBSERVATION_PROTECTION_PAYLOAD_KEY = 'secretObservationProtectionEnabled';
export const SECRET_OBSERVATION_PROTECTION_SETTING_KEY =
  'browserSecretObservationProtectionEnabled';

/**
 * Default ON once a reader is bound. Unbound (unit tests that never start the
 * gateway) leaves payloads untouched so existing command assertions stay exact.
 */
let readEnabled: () => boolean = () => true;
let readerBound = false;
let applyUnsubscribe: (() => void) | undefined;

export function isSecretObservationProtectionEnabled(): boolean {
  try {
    return readEnabled() !== false;
  } catch {
    return true;
  }
}

export function stampSecretObservationProtection(
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!readerBound) {
    return payload;
  }
  return {
    ...(payload ?? {}),
    [SECRET_OBSERVATION_PROTECTION_PAYLOAD_KEY]: isSecretObservationProtectionEnabled(),
  };
}

export function bindSecretObservationProtectionReader(reader: () => boolean): void {
  readEnabled = reader;
  readerBound = true;
}

export function resetSecretObservationProtectionReaderForTesting(): void {
  readEnabled = () => true;
  readerBound = false;
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
  const payload = stampSecretObservationProtection();
  for (const queueKey of queueKeysForApply(commandStore)) {
    void commandStore.sendCommand({
      queueKey,
      command: 'report_inventory',
      payload,
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
