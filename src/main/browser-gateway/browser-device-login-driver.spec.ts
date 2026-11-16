import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDeviceLoginMetadata } from '@contracts/types/browser';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';
import { createBrowserDeviceLoginDriver } from './browser-device-login-driver';
import { currentBrowserSessionOwner, withBrowserSession } from './browser-session-context';

const metadata: BrowserDeviceLoginMetadata = {
  operationHandle: 'test-operation', ownerSessionId: 'test-owner', ownerGeneration: 'test-owner-generation',
  nativeNodeId: 'test-native', nativeProfileId: 'test-native-profile', nativeComputerName: 'Test native',
  browserNodeId: 'test-browser', browserProfileId: 'test-browser-profile', browserComputerName: 'Test browser',
  targetId: 'test-target', origin: 'https://auth.openai.com', expectedIdentity: 'test@example.test',
  extensionInstanceId: 'test-install', extensionGeneration: '100',
  documentId: '11111111-1111-4111-8111-111111111111', expiresAt: 5000,
};
const completion = { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' };
afterEach(() => vi.useRealTimers());
function setup() {
  let now = 1000;
  const contacts = new BrowserExtensionContactState({ now: () => now });
  contacts.markExtensionContact(metadata.browserNodeId);
  contacts.markExtensionRuntime(metadata.browserNodeId, {
    extensionInstanceId: metadata.extensionInstanceId, extensionStartedAt: 100, extensionVersion: '0.2.52',
  });
  const ledger = new BrowserOneTimeCodeFillLedger(() => now);
  const requests: BrowserExtensionSendCommandRequest[] = [];
  const context = { documentId: metadata.documentId, extensionInstanceId: metadata.extensionInstanceId,
    extensionGeneration: metadata.extensionGeneration, identityMatches: true };
  const sendCommand = vi.fn(async (request: BrowserExtensionSendCommandRequest): Promise<unknown> => {
    requests.push(request);
    request.beforeDelivery?.();
    if (request.command === 'codex_device_context') return context;
    if (request.command === 'codex_device_attest') return { completed: true, deviceDocumentId: metadata.documentId };
    if (request.command === 'codex_device_cancel') return { completed: true };
    return completion;
  });
  const confidential = vi.fn(() => true);
  const deps = { commands: { sendCommand, cancelCommand: vi.fn(() => true) }, contacts, ledger,
    captureConfidentialConnection: vi.fn(() => confidential), isCurrent: vi.fn(() => true),
    isCleanupCurrent: vi.fn(() => true), isApproved: vi.fn(() => true), protectionEnabled: vi.fn(() => true), now: () => now };
  const destination = { ...metadata, tabId: 42 };
  const driver = createBrowserDeviceLoginDriver(deps, destination);
  const controller = new AbortController();
  async function ready() {
    await driver.context(controller.signal);
    await driver.attest(metadata, 'test-approval', controller.signal);
  }
  return { driver, ready, controller, deps, requests, context, destination, setNow: (value: number) => { now = value; } };
}

describe('private Codex browser driver', () => {
  it('keeps the original session owner for commands and cleanup called outside its context', async () => {
    const s = withBrowserSession('/tmp/aio-device-test', 'test-owner', setup);
    const owner = withBrowserSession('/tmp/aio-device-test', 'test-owner', currentBrowserSessionOwner);
    const observed: (string | undefined)[] = [];
    const send = s.deps.commands.sendCommand.getMockImplementation()!;
    s.deps.commands.sendCommand.mockImplementation(request => {
      observed.push(currentBrowserSessionOwner());
      return send(request);
    });
    await withBrowserSession('/tmp/aio-device-test', 'other-owner', s.ready);
    await s.driver.cancel();
    expect(observed).toEqual([owner, owner, owner]);
    expect(owner).toBeTruthy();
    expect(currentBrowserSessionOwner()).toBeUndefined();
  });
  it('uses only dedicated commands and spends a verified fill once', async () => {
    const s = setup();
    const record = vi.spyOn(s.deps.ledger, 'recordDevice');
    const consume = vi.spyOn(s.deps.ledger, 'consumeDevice');
    await s.ready();
    await s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
    expect(s.requests.map((r) => r.command)).toEqual([
      'codex_device_context', 'codex_device_attest', 'codex_device_fill', 'codex_device_submit',
    ]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: metadata.ownerSessionId, ownerGeneration: metadata.ownerGeneration,
      profileId: metadata.browserProfileId, nativeNodeId: metadata.nativeNodeId, approvalId: 'test-approval',
    }));
    expect(consume).toHaveBeenCalledOnce();
    expect(s.requests.every((request) => request.queueKey === 'node:test-browser'
      && request.target?.tabId === 42 && request.target.extensionInstanceId === 'test-install'
      && request.timeoutMs === 4000 && request.undeliveredWaitMs === 4000)).toBe(true);
    expect(s.requests[2]!.payload).not.toHaveProperty('code');
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(4);
  });

  it.each(['isCurrent', 'protectionEnabled', 'isApproved'] as const)('refuses changed %s before code dispatch', async (key) => {
    const s = setup(); await s.ready();
    s.deps[key].mockReturnValue(false);
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(2);
  });

  it.each(['browserProfileId', 'targetId', 'extensionGeneration', 'expectedIdentity', 'documentId', 'browserNodeId'] as const)(
    'refuses changed approved %s', async (key) => {
      const s = setup(); await s.driver.context(s.controller.signal);
      await expect(s.driver.attest({ ...metadata, [key]: 'different' }, 'test-approval', s.controller.signal))
        .rejects.toThrow('codex_device_handoff_refused');
      expect(s.requests).toHaveLength(1);
    });

  it('captures one transport lease and refuses its loss', async () => {
    const s = setup(); await s.ready(); s.deps.captureConfidentialConnection.mockClear();
    s.deps.captureConfidentialConnection().mockReturnValue(false); s.deps.captureConfidentialConnection.mockClear();
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.deps.captureConfidentialConnection).not.toHaveBeenCalled();
  });

  it.each([false, Promise.resolve(true)])('rejects non-synchronous authority %s', async (value) => {
    const s = setup(); await s.ready();
    s.deps.isApproved.mockImplementation(() => value as boolean);
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(2);
  });

  it('refuses an extension restart', async () => {
    const s = setup(); await s.ready();
    s.deps.contacts.markExtensionRuntime(metadata.browserNodeId, {
      extensionInstanceId: metadata.extensionInstanceId, extensionStartedAt: 101, extensionVersion: '0.2.52',
    });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(2);
  });

  it.each([{ ...completion, extra: 'TESTCODEX' }, { completed: true }, false])('does not submit after unverified fill', async (result) => {
    const s = setup(); await s.ready(); s.deps.commands.sendCommand.mockResolvedValueOnce(result);
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests.some((r) => r.command === 'codex_device_submit')).toBe(false);
  });

  it('sanitizes exceptions and never retries an ambiguous fill', async () => {
    const s = setup(); await s.ready(); s.deps.commands.sendCommand.mockRejectedValueOnce(new Error('TESTCODEX'));
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toEqual(new Error('codex_device_handoff_refused'));
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.deps.commands.sendCommand).toHaveBeenCalledTimes(3);
  });

  it('aborts a pending fill promptly and refuses later queued delivery', async () => {
    const s = setup(); await s.ready(); let pending: BrowserExtensionSendCommandRequest | undefined;
    s.deps.commands.sendCommand.mockImplementationOnce((request) => {
      pending = request; request.onQueued?.('test-command'); return new Promise(() => undefined);
    });
    const fill = s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
    s.controller.abort();
    await expect(fill).rejects.toThrow('codex_device_handoff_refused');
    expect(() => pending!.beforeDelivery!()).toThrow('codex_device_handoff_refused');
    expect(pending!.authorizeDeviceCommand!()).toBe(false);
    expect(pending!.payload).not.toHaveProperty('code');
    expect(s.deps.commands.cancelCommand).toHaveBeenCalledWith('node:test-browser', 'test-command');
  });

  it('does not submit after cancellation during fill', async () => {
    const s = setup(); await s.ready();
    s.deps.commands.sendCommand.mockImplementationOnce(async () => { await s.driver.cancel(); return completion; });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests.at(-1)!.command).toBe('codex_device_cancel');
  });

  it('refuses native expiry and excessive lifetime', async () => {
    const s = setup(); await s.ready(); s.setNow(metadata.expiresAt);
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(() => createBrowserDeviceLoginDriver(s.deps, { ...s.destination, expiresAt: 400000 })).toThrow('codex_device_handoff_refused');
  });

  it('rejects arbitrary context content', async () => {
    const s = setup(); s.deps.commands.sendCommand.mockResolvedValueOnce({ ...s.context, url: 'TESTCODEX' });
    await expect(s.driver.context(s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
  });

  it.each(['documentId', 'extensionInstanceId', 'extensionGeneration', 'identityMatches'] as const)(
    'rejects incorrect context %s', async (key) => {
      const s = setup();
      s.deps.commands.sendCommand.mockResolvedValueOnce({ ...s.context, [key]: 'different' });
      await expect(s.driver.context(s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    });

  it.each(['TEST-CODEX', 'TEST', 'TEST CODE', 'TESTCODEX0'])('refuses unsupported code format', async (code) => {
    const s = setup(); await s.ready();
    await expect(s.driver.fillAndSubmit(code, s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(2);
  });

  it('consumes atomically before submit dispatch and cannot regain the receipt', async () => {
    const s = setup(); await s.ready();
    const consume = vi.spyOn(s.deps.ledger, 'consumeDevice');
    const original = s.deps.commands.sendCommand.getMockImplementation()!;
    s.deps.commands.sendCommand.mockImplementation(async (request) => {
      if (request.command === 'codex_device_submit') {
        expect(consume).toHaveBeenCalledOnce();
        expect(s.deps.ledger.consumeDevice(consume.mock.calls[0]![0])).toBe(false);
      }
      return original(request);
    });
    await s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
  });

  it('rejects a missing confidential lease', () => {
    const s = setup();
    expect(() => createBrowserDeviceLoginDriver({ ...s.deps, captureConfidentialConnection: () => null }, s.destination))
      .toThrow('codex_device_handoff_refused');
  });

  it.each(['isCurrent', 'isApproved', 'protectionEnabled'] as const)('never exposes a thrown %s callback error', async (key) => {
    const s = setup(); await s.ready(); s.deps[key].mockImplementation(() => { throw new Error('TESTCODEX'); });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toEqual(new Error('codex_device_handoff_refused'));
  });

  it('refuses changed approval after fill, before recording or submitting', async () => {
    const s = setup(); await s.ready();
    const record = vi.spyOn(s.deps.ledger, 'recordDevice');
    s.deps.commands.sendCommand.mockImplementationOnce(async () => { s.deps.isApproved.mockReturnValue(false); return completion; });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a receipt spent by another fill before submit', async () => {
    const s = setup(); await s.ready();
    const original = s.deps.ledger.recordDevice.bind(s.deps.ledger);
    vi.spyOn(s.deps.ledger, 'recordDevice').mockImplementation((scope) => {
      const recorded = original(scope);
      s.deps.ledger.record({ ...scope, instanceId: 'other-owner' });
      return recorded;
    });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests.map((r) => r.command)).not.toContain('codex_device_submit');
  });

  it('burns both attempts when fill is reentrant', async () => {
    const s = setup(); await s.ready();
    s.deps.commands.sendCommand.mockImplementationOnce(() => new Promise(() => undefined));
    const first = s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
    const second = s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
    await expect(first).rejects.toThrow('codex_device_handoff_refused');
    await expect(second).rejects.toThrow('codex_device_handoff_refused');
    expect(s.deps.commands.sendCommand).toHaveBeenCalledTimes(3);
  });

  it('bounds a pending command by native expiry and removes it from the queue', async () => {
    vi.useFakeTimers();
    const s = setup(); await s.ready();
    s.deps.commands.sendCommand.mockImplementationOnce((request) => {
      request.onQueued?.('test-command'); return new Promise(() => undefined);
    });
    const pending = s.driver.fillAndSubmit('TESTCODEX', s.controller.signal);
    const rejected = expect(pending).rejects.toThrow('codex_device_handoff_refused');
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(s.deps.commands.cancelCommand).toHaveBeenCalledWith('node:test-browser', 'test-command');
  });

  it('never revives invalid cleanup authority to send cancellation', async () => {
    const s = setup(); await s.ready(); s.deps.isCleanupCurrent.mockReturnValue(false);
    await s.driver.cancel();
    expect(s.requests).toHaveLength(2);
  });

  it('uses cleanup authority after approval and write authority are revoked', async () => {
    const s = setup(); await s.ready();
    s.controller.abort(); s.deps.isCurrent.mockReturnValue(false); s.deps.isApproved.mockReturnValue(false);
    await s.driver.cancel(); await s.driver.cancel();
    expect(s.requests.map(request => request.command)).toEqual([
      'codex_device_context', 'codex_device_attest', 'codex_device_cancel',
    ]);
    expect(s.requests[2]!.payload).toEqual(s.requests[1]!.payload);
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.requests).toHaveLength(3);
  });

  it.each(['lease', 'runtime', 'protection', 'expiry', 'async cleanup'])(
    'refuses cancellation after loss of %s', async cause => {
      const s = setup(); await s.ready();
      if (cause === 'lease') s.deps.captureConfidentialConnection().mockReturnValue(false);
      if (cause === 'runtime') s.deps.contacts.markExtensionRuntime(metadata.browserNodeId, {
        extensionInstanceId: metadata.extensionInstanceId, extensionStartedAt: 101, extensionVersion: '0.2.52',
      });
      if (cause === 'protection') s.deps.protectionEnabled.mockReturnValue(false);
      if (cause === 'expiry') s.setNow(metadata.expiresAt);
      if (cause === 'async cleanup') s.deps.isCleanupCurrent.mockImplementation(() => Promise.resolve(true) as unknown as boolean);
      await s.driver.cancel(); expect(s.requests).toHaveLength(2);
    });

  it('rejects extra fields in submit completion without retrying submit', async () => {
    const s = setup(); await s.ready();
    s.deps.commands.sendCommand.mockResolvedValueOnce(completion).mockResolvedValueOnce({ ...completion, code: 'TESTCODEX' });
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toEqual(new Error('codex_device_handoff_refused'));
    await expect(s.driver.fillAndSubmit('TESTCODEX', s.controller.signal)).rejects.toThrow('codex_device_handoff_refused');
    expect(s.deps.commands.sendCommand).toHaveBeenCalledTimes(4);
  });
});
