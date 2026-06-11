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

  it('isolates local and remote node command queues', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'snapshot',
      target: {
        profileId: 'existing-tab:n.node-1:7:42',
        targetId: 'existing-tab:n.node-1:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      queueKey: 'node:node-1',
      timeoutMs: 1_000,
    } as never);

    await expect(store.pollCommand('local' as never, { timeoutMs: 1 })).resolves.toBeNull();
    const command = await store.pollCommand('node:node-1' as never, { timeoutMs: 1 });
    expect(command).toMatchObject({
      command: 'snapshot',
      target: {
        tabId: 42,
        windowId: 7,
      },
    });
    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: { ok: true },
      queueKey: 'node:node-1',
    } as never);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects command results from a different queue', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'click',
      target: {
        profileId: 'existing-tab:n.node-1:7:42',
        targetId: 'existing-tab:n.node-1:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      queueKey: 'node:node-1',
      timeoutMs: 1_000,
    } as never);
    const command = await store.pollCommand('node:node-1' as never, { timeoutMs: 1 });

    expect(() =>
      store.resolveCommand({
        commandId: command!.id,
        ok: true,
        result: { clicked: true },
        queueKey: 'node:node-2',
      } as never),
    ).toThrow(/browser_extension_command_queue_mismatch/);

    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: { clicked: true },
      queueKey: 'node:node-1',
    } as never);
    await expect(pending).resolves.toEqual({ clicked: true });
  });

  it('rejects pending commands and releases pollers for a rejected queue', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      queueKey: 'node:node-1',
      command: 'snapshot',
      timeoutMs: 10_000,
    });
    await expect(store.pollCommand('node:node-1', { timeoutMs: 1 })).resolves.toMatchObject({
      command: 'snapshot',
    });
    const poll = store.pollCommand('node:node-1', { timeoutMs: 10_000 });

    store.rejectQueue('node:node-1', 'node_disconnected');

    await expect(pending).rejects.toThrow('node_disconnected');
    await expect(poll).resolves.toBeNull();
  });
});
