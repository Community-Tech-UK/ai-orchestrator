import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import {
  applySecretObservationProtectionToQueues,
  bindSecretObservationProtectionReader,
  isSecretObservationProtectionEnabled,
  resetSecretObservationProtectionReaderForTesting,
  stampSecretObservationProtection,
} from './browser-secret-observation-protection';

describe('browser secret observation protection stamp', () => {
  afterEach(() => {
    resetSecretObservationProtectionReaderForTesting();
    BrowserExtensionCommandStore._resetForTesting();
  });

  it('leaves payloads untouched until a reader is bound', () => {
    expect(stampSecretObservationProtection({ selector: '#pass' })).toEqual({ selector: '#pass' });
    expect(stampSecretObservationProtection()).toBeUndefined();
    expect(isSecretObservationProtectionEnabled()).toBe(true);
  });

  it('stamps false when the operator setting is off and overwrites a caller value', () => {
    bindSecretObservationProtectionReader(() => false);
    expect(stampSecretObservationProtection({
      selector: '#pass',
      secretObservationProtectionEnabled: true,
    })).toEqual({
      selector: '#pass',
      secretObservationProtectionEnabled: false,
    });
    expect(isSecretObservationProtectionEnabled()).toBe(false);
  });

  it('stamps true when the operator setting is on', () => {
    bindSecretObservationProtectionReader(() => true);
    expect(stampSecretObservationProtection()).toEqual({
      secretObservationProtectionEnabled: true,
    });
  });

  it('fails closed to on when the reader throws', () => {
    bindSecretObservationProtectionReader(() => {
      throw new Error('settings unavailable');
    });
    expect(isSecretObservationProtectionEnabled()).toBe(true);
    expect(stampSecretObservationProtection({})).toEqual({
      secretObservationProtectionEnabled: true,
    });
  });

  it('pushes the current flag on every active extension queue', async () => {
    bindSecretObservationProtectionReader(() => false);
    const store = new BrowserExtensionCommandStore();
    const localPoll = store.pollCommand({ timeoutMs: 50 });
    const remotePoll = store.pollCommand('node:windows-pc', { timeoutMs: 50 });
    applySecretObservationProtectionToQueues(store);
    const localCmd = await localPoll;
    const remoteCmd = await remotePoll;
    expect(localCmd).toMatchObject({
      command: 'report_inventory',
      payload: { secretObservationProtectionEnabled: false },
    });
    expect(remoteCmd).toMatchObject({
      command: 'report_inventory',
      payload: { secretObservationProtectionEnabled: false },
    });
    store.resolveCommand({ commandId: localCmd!.id, ok: true, result: { reported: true } });
    store.resolveCommand({
      commandId: remoteCmd!.id,
      queueKey: 'node:windows-pc',
      ok: true,
      result: { reported: true },
    });
  });

  it('stamps every command the store queues, whichever caller sent it', async () => {
    bindSecretObservationProtectionReader(() => false);
    const store = new BrowserExtensionCommandStore();
    // open_tab and the list_targets inventory refresh used to go out unstamped.
    const openTab = store.sendCommand({
      queueKey: 'node:windows-pc',
      command: 'open_tab',
      payload: { url: 'https://example.test/' },
      timeoutMs: 1_000,
    });
    const refresh = store.sendCommand({ queueKey: 'node:windows-pc', command: 'report_inventory', timeoutMs: 1_000 });
    const first = await store.pollCommand('node:windows-pc', { timeoutMs: 50 });
    const second = await store.pollCommand('node:windows-pc', { timeoutMs: 50 });
    expect(first).toMatchObject({
      command: 'open_tab',
      payload: { url: 'https://example.test/', secretObservationProtectionEnabled: false },
    });
    expect(second).toMatchObject({
      command: 'report_inventory',
      payload: { secretObservationProtectionEnabled: false },
    });
    store.resolveCommand({ commandId: first!.id, queueKey: 'node:windows-pc', ok: true, result: {} });
    store.resolveCommand({ commandId: second!.id, queueKey: 'node:windows-pc', ok: true, result: {} });
    await Promise.all([openTab, refresh]);
  });

  it('records the protection state an extension reports from report_inventory', async () => {
    const store = new BrowserExtensionCommandStore();
    expect(store.describeSecretObservation('node:windows-pc')).toBeUndefined();

    const refresh = store.sendCommand({ queueKey: 'node:windows-pc', command: 'report_inventory', timeoutMs: 1_000 });
    const command = await store.pollCommand('node:windows-pc', { timeoutMs: 50 });
    store.resolveCommand({
      commandId: command!.id,
      queueKey: 'node:windows-pc',
      ok: true,
      result: {
        reported: true,
        secretObservation: { protectionEnabled: true, taintedOriginCount: 2, taintedTabCount: 3 },
      },
    });
    await refresh;

    expect(store.describeSecretObservation('node:windows-pc')).toMatchObject({
      protectionEnabled: true,
      taintedOriginCount: 2,
      taintedTabCount: 3,
      observedAt: expect.any(Number),
    });
    expect(store.describeSecretObservation('local')).toBeUndefined();
  });

  it('ignores a malformed or missing report and keeps the last good one', async () => {
    const store = new BrowserExtensionCommandStore();
    const send = async (result: unknown) => {
      const pending = store.sendCommand({ command: 'report_inventory', timeoutMs: 1_000 });
      const command = await store.pollCommand({ timeoutMs: 50 });
      store.resolveCommand({ commandId: command!.id, ok: true, result });
      await pending;
    };
    await send({ reported: true, secretObservation: { protectionEnabled: false, taintedOriginCount: 0, taintedTabCount: 0 } });
    await send({ reported: true });
    await send({ reported: true, secretObservation: { protectionEnabled: 'no', taintedOriginCount: -1, taintedTabCount: 0 } });

    expect(store.describeSecretObservation('local')).toMatchObject({
      protectionEnabled: false,
      taintedOriginCount: 0,
    });
  });
});

