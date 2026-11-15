import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserDeviceLoginOperationController } from './browser-device-login-operation';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';
import { CodexDeviceTransferRegistry } from '../remote-node/codex-device-transfer';
import type { CodexDeviceLoginHandoffParams } from '../remote-node/codex-device-login-rpc';
import type { BrowserApprovalRequestInput } from './browser-approval-store';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';
const owner = { sessionId: 'test-owner', generation: 'test-generation' };
const handle = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const fill = { loginHandle: handle, profileId: 'browser-profile', targetId: 'target' };
const native = { nodeId: 'native', profileId: 'fresh-profile' };
const refused = new Error('device_login_request_refused');
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const snapshot = { object: {}, restartEpoch: 1, adapterGeneration: 1 };
  const view = { handle, ...native, provider: 'codex' as const, expectedIdentity: 'test@example.test', expiresAt: 61000, state: 'awaiting_handoff' as const };
  const requests = new Map<string, BrowserApprovalRequest>();
  const approvals = {
    createRequest: vi.fn((input: BrowserApprovalRequestInput) => {
      const request: BrowserApprovalRequest = { ...input, id: 'approval', requestId: 'approval', status: 'pending', createdAt: Date.now() };
      requests.set(request.requestId, request); return request;
    }),
    findDeviceLoginRequest: vi.fn(() => requests.get('approval') ?? null),
    invalidateDeviceLoginRequests: vi.fn(() => { for (const request of requests.values()) request.status = 'expired'; }),
  };
  const contacts = new BrowserExtensionContactState();
  contacts.markExtensionContact('browser');
  contacts.markExtensionRuntime('browser', { extensionInstanceId: 'test-install', extensionStartedAt: 100, extensionVersion: '0.2.52' });
  const commands: string[] = [];
  const sendCommand = vi.fn(async (request: BrowserExtensionSendCommandRequest): Promise<unknown> => {
    commands.push(request.command); request.beforeDelivery?.();
    if (request.command === 'codex_device_context') return { documentId, extensionInstanceId: 'test-install', extensionGeneration: '100', identityMatches: true };
    if (request.command === 'codex_device_attest') return { completed: true, deviceDocumentId: documentId };
    if (request.command === 'codex_device_cancel') return { completed: true };
    return { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' };
  });
  const transfers = new CodexDeviceTransferRegistry();
  const request = vi.fn(async (_node: string, method: string, params: unknown): Promise<unknown> => {
    if (method.endsWith('.handoff')) {
      const handoff = params as CodexDeviceLoginHandoffParams;
      await transfers.receive('native', { ...handoff, expiresAt: view.expiresAt, code: 'TESTCODEX' }, () => true);
      return { ...view, state: 'awaiting_login' };
    }
    return { ...view, ...(method.endsWith('.cancel') ? { state: 'cancelled' } : {}) };
  });
  const deps = { resolveOwner: vi.fn(() => snapshot), resolveNative: vi.fn(() => ({ ...native, computerName: 'Native', expectedIdentity: view.expectedIdentity })),
    resolveTarget: vi.fn(async () => ({ browserNodeId: 'browser', browserProfileId: fill.profileId, targetId: fill.targetId, tabId: 1,
      extensionInstanceId: 'test-install', extensionGeneration: '100', computerName: 'Browser', isCurrent: () => true })),
    worker: { request }, captureConfidentialConnection: vi.fn((): (() => boolean) => () => true), approvals, transfers,
    commands: { sendCommand, cancelCommand: vi.fn(() => true) }, contacts, ledger: new BrowserOneTimeCodeFillLedger(), protectionEnabled: () => true };
  const controller = new BrowserDeviceLoginOperationController(deps);
  return { controller, deps, requests, commands, view, snapshot };
}
describe('device login operation controller', () => {
  it('requires exact approval before private transfer, then submits only once', async () => {
    const s = setup(); await s.controller.start(native, owner);
    expect(await s.controller.fill(fill, owner)).toMatchObject({ status: 'requires_approval', requestId: 'approval' });
    expect(await s.controller.fill(fill, owner)).toMatchObject({ status: 'requires_approval' });
    expect(s.deps.approvals.createRequest).toHaveBeenCalledOnce();
    expect(s.commands).toEqual(['codex_device_context']);
    s.requests.get('approval')!.status = 'approved';
    const result = await s.controller.fill(fill, owner);
    expect(result).toMatchObject({ status: 'submitted', operation: { state: 'awaiting_login' } });
    expect(JSON.stringify(result)).not.toContain('TESTCODEX');
    expect(s.commands).toEqual(['codex_device_context', 'codex_device_attest', 'codex_device_fill', 'codex_device_submit']);
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    s.controller.shutdown();
  });
  it.each(['denied', 'expired'] as const)('never renews %s approval', async status => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.requests.get('approval')!.status = status;
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    expect(s.deps.approvals.createRequest).toHaveBeenCalledOnce(); s.controller.shutdown();
  });
  it('refuses another owner without cancelling the actual owner', async () => {
    const s = setup(); await s.controller.start(native, owner);
    await expect(s.controller.cancel(handle, { ...owner, generation: 'old' })).rejects.toEqual(refused);
    expect(await s.controller.read(handle, owner)).toEqual(s.view); s.controller.shutdown();
  });
  it.each(['expectedIdentity', 'nodeId', 'profileId'] as const)('refuses wrong native %s without exposing response', async key => {
    const s = setup(); s.deps.worker.request.mockResolvedValueOnce({ ...s.view, [key]: 'wrong@example.test' });
    await expect(s.controller.start(native, owner)).rejects.toEqual(refused); s.controller.shutdown();
  });
  it('cancels context in flight and prevents late approval creation', async () => {
    const s = setup(); await s.controller.start(native, owner);
    s.deps.commands.sendCommand.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = s.controller.fill(fill, owner); const rejected = expect(pending).rejects.toEqual(refused);
    await Promise.resolve(); await s.controller.cancel(handle, owner); await rejected;
    expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); s.controller.shutdown();
  });
  it('refuses owner replacement and expiry', async () => {
    const s = setup(); await s.controller.start(native, owner);
    s.snapshot.restartEpoch++;
    await expect(s.controller.read(handle, owner)).rejects.toEqual(refused);
    s.controller.shutdown();
    const t = setup(); await t.controller.start(native, owner); await vi.advanceTimersByTimeAsync(60000);
    await expect(t.controller.fill(fill, owner)).rejects.toEqual(refused); t.controller.shutdown();
  });
  it('locks concurrent fills before target resolution', async () => {
    const s = setup(); await s.controller.start(native, owner);
    const first = s.controller.fill(fill, owner);
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    await first;
    expect(s.deps.approvals.createRequest).toHaveBeenCalledOnce(); s.controller.shutdown();
  });
  it('reserves a native profile before its start response and cancels a late response after shutdown', async () => {
    const s = setup(); let complete!: (value: unknown) => void;
    s.deps.worker.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = s.controller.start(native, owner); const rejected = expect(first).rejects.toEqual(refused);
    await expect(s.controller.start(native, owner)).rejects.toEqual(refused);
    s.controller.shutdown(); await rejected;
    complete(s.view); await Promise.resolve();
    expect(s.deps.worker.request.mock.calls.map(call => call[1])).toEqual(['provider.codexDevice.start', 'provider.codexDevice.cancel']);
  });
  it('refuses modified approved metadata instead of creating a replacement approval', async () => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.requests.get('approval')!.status = 'approved';
    s.requests.get('approval')!.deviceLogin = { ...s.requests.get('approval')!.deviceLogin!, expectedIdentity: 'other@example.test' };
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    expect(s.commands).not.toContain('codex_device_attest');
    expect(s.deps.approvals.createRequest).toHaveBeenCalledOnce(); s.controller.shutdown();
  });
  it('refuses owner change during attestation before native release', async () => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.requests.get('approval')!.status = 'approved';
    s.deps.commands.sendCommand.mockImplementationOnce(async () => {
      s.snapshot.adapterGeneration++; return { completed: true, deviceDocumentId: documentId };
    });
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    expect(s.deps.worker.request.mock.calls.some(call => call[1].endsWith('.handoff'))).toBe(false); s.controller.shutdown();
  });
  it('invalidates approval on either node disconnect', async () => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.controller.invalidateNode('browser');
    expect(s.requests.get('approval')!.status).toBe('expired');
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused); s.controller.shutdown();
  });
  it('returns only a fixed error for private worker exceptions', async () => {
    const s = setup(); s.deps.worker.request.mockRejectedValueOnce(new Error('TESTCODEX'));
    await expect(s.controller.start(native, owner)).rejects.toEqual(refused); s.controller.shutdown();
  });

  it('aborts private delivery during fill and never submits after cancellation', async () => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.requests.get('approval')!.status = 'approved';
    const original = s.deps.commands.sendCommand.getMockImplementation()!;
    let entered!: () => void;
    const filling = new Promise<void>(resolve => { entered = resolve; });
    s.deps.commands.sendCommand.mockImplementation(request => {
      if (request.command === 'codex_device_fill') { entered(); return new Promise(() => undefined); }
      return original(request);
    });
    const pending = s.controller.fill(fill, owner); const rejected = expect(pending).rejects.toEqual(refused);
    await filling; await s.controller.cancel(handle, owner); await rejected;
    expect(s.commands).not.toContain('codex_device_submit');
    expect(s.requests.get('approval')!.status).toBe('expired'); s.controller.shutdown();
  });
  it('refuses loss of the captured native connection rather than acquiring a new lease', async () => {
    const s = setup(); const nativeLease = vi.fn(() => true);
    s.deps.captureConfidentialConnection.mockReturnValueOnce(nativeLease);
    await s.controller.start(native, owner); nativeLease.mockReturnValue(false);
    await expect(s.controller.fill(fill, owner)).rejects.toEqual(refused);
    expect(s.commands).toEqual([]); s.controller.shutdown();
  });

});
