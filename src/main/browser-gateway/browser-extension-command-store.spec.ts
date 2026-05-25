import { describe, expect, it } from 'vitest';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';

describe('BrowserExtensionCommandStore', () => {
  it('delivers a queued tab command to the extension and resolves the caller result', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'click',
      target: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#submit',
      },
      timeoutMs: 1_000,
    });

    const command = await store.pollCommand({ timeoutMs: 1 });

    expect(command).toMatchObject({
      command: 'click',
      target: {
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#submit',
      },
    });

    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: {
        clicked: true,
      },
    });

    await expect(pending).resolves.toEqual({
      clicked: true,
    });
  });

  it('returns null when the extension polls and no command arrives before the timeout', async () => {
    const store = new BrowserExtensionCommandStore();

    await expect(store.pollCommand({ timeoutMs: 1 })).resolves.toBeNull();
  });
});
