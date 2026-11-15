import { afterEach, describe, expect, it } from 'vitest';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserExtensionPollRequest, BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';

const queueKey = 'node:test-node';
const stores: BrowserExtensionCommandStore[] = [];
function setup() {
  const store = new BrowserExtensionCommandStore();
  stores.push(store);
  const request: BrowserExtensionSendCommandRequest = {
    queueKey,
    command: 'codex_device_fill',
    target: { tabId: 42, extensionInstanceId: 'test-install' },
    payload: { code: 'NON_SECRET_TEST_PLACEHOLDER' },
    authorizeDeviceCommand: () => true,
    timeoutMs: 1_000,
  };
  const poll: BrowserExtensionPollRequest = {
    timeoutMs: 1,
    extensionInstanceId: 'test-install',
    deferHandoffConfirmation: true,
    allowDeviceLoginCommands: true,
    confidentialTransport: () => true,
  };
  return { store, request, poll };
}
afterEach(() => { for (const store of stores.splice(0)) store.rejectQueue(queueKey, 'test_cleanup'); });

describe('private device command delivery', () => {
  it.each([undefined, () => false, () => Promise.resolve(true)])('requires synchronous affirmative authority before queueing (%s)', async (authorizeDeviceCommand) => {
    const { store, request } = setup();
    await expect(store.sendCommand({ ...request, authorizeDeviceCommand } as BrowserExtensionSendCommandRequest))
      .rejects.toThrow('codex_device_delivery_rejected');
    expect(store.describeQueue(queueKey).queuedCount).toBe(0);
  });

  it('refuses a poll without a transport proof', async () => {
    const { store, request, poll } = setup();
    const pending = store.sendCommand(request);
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    await expect(store.pollCommand(queueKey, { ...poll, confidentialTransport: undefined } as BrowserExtensionPollRequest)).resolves.toBeNull();
    await rejected;
  });

  it('refuses an encrypted poll from an extension without device handoff support', async () => {
    const { store, request, poll } = setup();
    const pending = store.sendCommand(request);
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    await expect(store.pollCommand(queueKey, { ...poll, allowDeviceLoginCommands: false })).resolves.toBeNull();
    await rejected;
  });

  it('rechecks the exact incoming poll connection before its socket write', async () => {
    const { store, request, poll } = setup();
    let connected = true;
    const pending = store.sendCommand(request);
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    const command = await store.pollCommand(queueKey, { ...poll, confidentialTransport: () => connected } as BrowserExtensionPollRequest);
    expect(command).not.toBeNull();
    connected = false;
    expect(store.validateCommandHandoff(queueKey, command!.id)).toBe(false);
    await rejected;
  });

  it('rechecks operation authority after a queue wait', async () => {
    const { store, request, poll } = setup();
    let authorized = true;
    const pending = store.sendCommand({ ...request, authorizeDeviceCommand: () => authorized } as BrowserExtensionSendCommandRequest);
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    authorized = false;
    await expect(store.pollCommand(queueKey, poll)).resolves.toBeNull();
    await rejected;
  });

  it('delivers while both proofs remain valid without serializing either callback', async () => {
    const { store, request, poll } = setup();
    const pending = store.sendCommand(request);
    const command = await store.pollCommand(queueKey, poll);
    expect(command).not.toBeNull();
    expect(command).not.toHaveProperty('authorizeDeviceCommand');
    expect(command).not.toHaveProperty('confidentialTransport');
    expect(store.validateCommandHandoff(queueKey, command!.id)).toBe(true);
    store.confirmCommandHandoff(queueKey, command!.id);
    store.resolveCommand({ queueKey, commandId: command!.id, ok: true, result: { completed: true } });
    await expect(pending).resolves.toEqual({ completed: true });
  });

  it('cancels and erases a queued private payload before any poll can receive it', async () => {
    const { store, request, poll } = setup();
    let id = '';
    const pending = store.sendCommand({ ...request, onQueued: (commandId) => { id = commandId; } });
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    expect(store.cancelCommand(queueKey, id)).toBe(true);
    expect(store.cancelCommand(queueKey, id)).toBe(false);
    await rejected;
    expect(store.describeQueue(queueKey).queuedCount).toBe(0);
    await expect(store.pollCommand(queueKey, poll)).resolves.toBeNull();
  });

  it.each(['result', 'disconnect', 'authority'])('erases a polled private payload on %s cleanup', async (ending) => {
    const { store, request, poll } = setup();
    let authorized = true;
    const pending = store.sendCommand({ ...request, authorizeDeviceCommand: () => authorized });
    const settled = pending.catch(() => undefined);
    const command = await store.pollCommand(queueKey, poll);
    if (ending === 'result') store.resolveCommand({ queueKey, commandId: command!.id, ok: true, result: {} });
    if (ending === 'disconnect') store.rejectQueue(queueKey, 'test_disconnect');
    if (ending === 'authority') { authorized = false; store.validateCommandHandoff(queueKey, command!.id); }
    await settled;
    expect(command!.payload).not.toHaveProperty('code');
  });

  it('withdraws a polled private payload and releases the following handoff', async () => {
    const { store, request, poll } = setup();
    const pending = store.sendCommand(request);
    const rejected = expect(pending).rejects.toThrow('codex_device_delivery_rejected');
    const command = await store.pollCommand(queueKey, poll);
    expect(store.cancelCommand('node:other', command!.id)).toBe(false);
    expect(store.cancelCommand(queueKey, command!.id)).toBe(true);
    await rejected;
    expect(command!.payload).not.toHaveProperty('code');
    expect(store.validateCommandHandoff(queueKey, command!.id)).toBe(false);
    expect(store.requeueUndeliveredCommand(queueKey, command!.id)).toBe(false);
  });
});
