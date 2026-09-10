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
});
