import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
} from './browser-extension-command-store';
import { refreshBrowserExtensionInventory } from './browser-extension-inventory-refresh';

describe('refreshBrowserExtensionInventory', () => {
  it('lets idempotent report_inventory wait through one extension recovery cycle before marking stale', async () => {
    const sendCommand = vi.fn(async () => undefined);

    await refreshBrowserExtensionInventory({
      request: { nodeId: 'node-1' },
      commandStore: { sendCommand },
    });

    expect(sendCommand).toHaveBeenCalledWith({
      queueKey: 'node:node-1',
      command: 'report_inventory',
      timeoutMs: 3_000,
      executionTimeoutMs: 2_500,
      undeliveredWaitMs: BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
    });
  });
});
