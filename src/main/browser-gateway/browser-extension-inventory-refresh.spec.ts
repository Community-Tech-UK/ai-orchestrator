import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
  BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import { refreshBrowserExtensionInventory } from './browser-extension-inventory-refresh';

describe('refreshBrowserExtensionInventory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('LT-618: a realistic multi-tab report_inventory answers within the raised refresh budget', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();

    const refreshPromise = refreshBrowserExtensionInventory({
      request: { nodeId: 'node-1' },
      commandStore: store,
    });
    const command = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    expect(command).toMatchObject({ command: 'report_inventory' });

    // A real multi-tab extension needs to walk every tab's buildTabPayload
    // (page-text capture + secret-taint lineage checks) before it can ack —
    // browser-gateway-refresh-support.ts documents this outliving the old
    // 2.5-3s budget on any non-trivial node. 6s is a realistic few-tab
    // duration, well inside the new budget but well past the old one.
    await vi.advanceTimersByTimeAsync(6_000);
    store.resolveCommand({
      queueKey: 'node:node-1',
      commandId: command!.id,
      ok: true,
      result: {
        reported: true,
        secretObservation: { protectionEnabled: true, taintedOriginCount: 0, taintedTabCount: 0 },
      },
    });

    await expect(refreshPromise).resolves.toEqual([
      { queueKey: 'node:node-1', nodeId: 'node-1', ok: true },
    ]);
  });

  it('lets idempotent report_inventory wait through one extension recovery cycle before marking stale', async () => {
    const sendCommand = vi.fn(async () => undefined);

    await refreshBrowserExtensionInventory({
      request: { nodeId: 'node-1' },
      commandStore: { sendCommand },
    });

    expect(sendCommand).toHaveBeenCalledWith({
      queueKey: 'node:node-1',
      command: 'report_inventory',
      // LT-618: 2.5-3s was too tight for a real multi-tab node to finish
      // rebuilding its full inventory before acking (see
      // browser-gateway-refresh-support.ts's own comment). Raised to 10-10.5s.
      timeoutMs: 10_500,
      executionTimeoutMs: 10_000,
      undeliveredWaitMs: BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
    });
  });
});
