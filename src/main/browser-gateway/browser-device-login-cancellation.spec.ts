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
describe('controller cancellation cleanup', () => {
  it('erases only the attested operation after abort and approval invalidation', async () => {
    const s = setup(); await s.controller.start(native, owner); await s.controller.fill(fill, owner);
    s.requests.get('approval')!.status = 'approved';
    const original = s.deps.commands.sendCommand.getMockImplementation()!;
    let entered!: () => void;
    const filling = new Promise<void>(resolve => { entered = resolve; });
    let stalled: BrowserExtensionSendCommandRequest | undefined;
    s.deps.commands.sendCommand.mockImplementation(request => {
      if (request.command === 'codex_device_fill') {
        stalled = request; request.beforeDelivery?.(); entered(); return new Promise(() => undefined);
      }
      return original(request);
    });
    const pending = s.controller.fill(fill, owner);
    const rejected = expect(pending).rejects.toEqual(refused);
    await filling; await s.controller.cancel(handle, owner); await rejected;
    const cancellations = s.deps.commands.sendCommand.mock.calls.map(([request]) => request)
      .filter(request => request.command === 'codex_device_cancel');
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ queueKey: 'node:browser',
      target: { tabId: 1, extensionInstanceId: 'test-install' },
      payload: { binding: { operationHandle: handle, approvalId: 'approval', expectedIdentity: s.view.expectedIdentity,
        expiresAt: s.view.expiresAt, extensionInstanceId: 'test-install', extensionGeneration: '100', documentId } } });
    expect(cancellations[0]!.payload).not.toHaveProperty('code');
    expect(stalled!.authorizeDeviceCommand!()).toBe(false);
    expect(() => stalled!.beforeDelivery!()).toThrow('codex_device_handoff_refused');
    expect(s.commands).not.toContain('codex_device_submit');
    expect(s.requests.get('approval')!.status).toBe('expired');
    await s.controller.cancel(handle, owner);
    expect(s.deps.commands.sendCommand.mock.calls.filter(([request]) => request.command === 'codex_device_cancel')).toHaveLength(1);
    s.controller.shutdown();
  });
});
