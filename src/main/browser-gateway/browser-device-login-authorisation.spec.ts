import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserDeviceLoginOperationController } from './browser-device-login-operation';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';
import { CodexDeviceTransferRegistry } from '../remote-node/codex-device-transfer';
import type { CodexDeviceLoginHandoffParams } from '../remote-node/codex-device-login-rpc';
import type { BrowserApprovalRequestInput } from './browser-approval-store';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';

/**
 * Controller-level proof for Step 2 of the Codex device-login plan: every refusal below must happen
 * before the native code is resolved, filled or submitted, and no outcome may carry the code.
 * The placeholder is an obvious test value, not a real device code.
 */
const CODE = 'TESTCODEX';
const owner = { sessionId: 'test-owner', generation: 'test-generation' };
const handle = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const fill = { loginHandle: handle, profileId: 'browser-profile', targetId: 'target' };
const native = { nodeId: 'native', profileId: 'fresh-profile' };
const refused = new Error('device_login_request_refused');
const runtime = (extensionStartedAt: number, extensionVersion = '0.2.52') =>
  ({ extensionInstanceId: 'test-install', extensionStartedAt, extensionVersion });

let output: string[] = [];
beforeEach(() => {
  output = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
  }
});
afterEach(() => {
  // Whatever each case did, nothing it printed may contain the code.
  expect(output.join('\n')).not.toContain(CODE);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  contacts.markExtensionRuntime('browser', runtime(100));
  const sendCommand = vi.fn(async (request: BrowserExtensionSendCommandRequest): Promise<unknown> => {
    request.beforeDelivery?.();
    if (request.command === 'codex_device_context') return { documentId, extensionInstanceId: 'test-install', extensionGeneration: '100', identityMatches: true };
    if (request.command === 'codex_device_attest') return { completed: true, deviceDocumentId: documentId };
    if (request.command === 'codex_device_cancel') return { completed: true };
    return { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' };
  });
  const transfers = new CodexDeviceTransferRegistry();
  const request = vi.fn(async (_node: string, method: string, params: unknown): Promise<unknown> => {
    if (method.endsWith('.handoff')) {
      const handoff = params as CodexDeviceLoginHandoffParams;
      await transfers.receive('native', { ...handoff, expiresAt: view.expiresAt, code: CODE }, () => true);
      return { ...view, state: 'awaiting_login' };
    }
    return { ...view, ...(method.endsWith('.cancel') ? { state: 'cancelled' } : {}) };
  });
  const target = { browserNodeId: 'browser', browserProfileId: fill.profileId, targetId: fill.targetId, tabId: 1,
    extensionInstanceId: 'test-install', extensionGeneration: '100', computerName: 'Browser', isCurrent: () => true };
  const deps = { resolveOwner: vi.fn(() => snapshot),
    resolveNative: vi.fn(() => ({ ...native, computerName: 'Native', expectedIdentity: view.expectedIdentity })),
    resolveTarget: vi.fn(async () => ({ ...target })),
    worker: { request }, captureConfidentialConnection: vi.fn((): (() => boolean) | null => () => true), approvals, transfers,
    commands: { sendCommand, cancelCommand: vi.fn(() => true) }, contacts, ledger: new BrowserOneTimeCodeFillLedger(),
    protectionEnabled: vi.fn(() => true) };
  const controller = new BrowserDeviceLoginOperationController(deps);
  const approved = async () => {
    await controller.start(native, owner); await controller.fill(fill, owner);
    requests.get('approval')!.status = 'approved';
  };
  return { controller, deps, requests, view, snapshot, approved };
}
type Setup = ReturnType<typeof setup>;
const sent = (s: Setup) => s.deps.commands.sendCommand.mock.calls.map(call => call[0].command);
const count = (s: Setup, command: string) => sent(s).filter(entry => entry === command).length;
const handoffs = (s: Setup) => s.deps.worker.request.mock.calls.filter(call => call[1].endsWith('.handoff')).length;
/** The code never left the native worker: no handoff, no write, no submit. */
function expectNoRelease(s: Setup) {
  expect(handoffs(s)).toBe(0);
  expect(count(s, 'codex_device_fill')).toBe(0);
  expect(count(s, 'codex_device_submit')).toBe(0);
}
async function expectRefused(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toEqual(refused);
  expect(JSON.stringify(error)).not.toContain(CODE);
}

describe('device login authorisation: nothing resolves or fills a code', () => {
  describe('before approval', () => {
    it.each([{ sessionId: 'another-session' }, { generation: 'another-generation' }])('refuses a foreign owner %j', async change => {
      const s = setup(); await s.approved();
      await expectRefused(s.controller.fill(fill, { ...owner, ...change }));
      expectNoRelease(s);
      // The real owner is not cancelled by the stranger's attempt.
      expect(await s.controller.read(handle, owner)).toMatchObject({ state: 'awaiting_handoff' });
      s.controller.shutdown();
    });
    it('refuses an unknown handle', async () => {
      const s = setup(); await s.approved();
      await expectRefused(s.controller.fill({ ...fill, loginHandle: '33333333-3333-4333-8333-333333333333' }, owner));
      expectNoRelease(s); s.controller.shutdown();
    });
    it.each([
      ['target', { targetId: 'other-target' }],
      ['browser profile', { browserProfileId: 'other-profile' }],
    ])('refuses a resolved %s that differs from the one requested', async (_label, change) => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.resolveTarget.mockImplementationOnce(async () => ({ browserNodeId: 'browser', browserProfileId: fill.profileId,
        targetId: fill.targetId, tabId: 1, extensionInstanceId: 'test-install', extensionGeneration: '100', computerName: 'Browser',
        isCurrent: () => true, ...change }));
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled();
      expect(count(s, 'codex_device_context')).toBe(0); expectNoRelease(s); s.controller.shutdown();
    });
    it.each([
      ['target', { targetId: 'other-target' }],
      ['browser profile', { profileId: 'other-profile' }],
    ])('refuses a retry that names another %s after approval', async (_label, change) => {
      const s = setup(); await s.approved();
      await expectRefused(s.controller.fill({ ...fill, ...change }, owner));
      expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a shared tab that stops being current', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.resolveTarget.mockImplementationOnce(async () => ({ browserNodeId: 'browser', browserProfileId: fill.profileId,
        targetId: fill.targetId, tabId: 1, extensionInstanceId: 'test-install', extensionGeneration: '100', computerName: 'Browser',
        isCurrent: () => false }));
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a native node that no longer matches', async () => {
      const s = setup(); await s.approved();
      s.deps.resolveNative.mockReturnValue({ nodeId: 'another-native', profileId: native.profileId, computerName: 'Native',
        expectedIdentity: s.view.expectedIdentity });
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a changed expected identity on the native side', async () => {
      const s = setup(); await s.approved();
      s.deps.resolveNative.mockReturnValue({ ...native, computerName: 'Native', expectedIdentity: 'other@example.test' });
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a browser computer without a confidential connection', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.captureConfidentialConnection.mockReturnValueOnce(null);
      await expectRefused(s.controller.fill(fill, owner));
      expect(count(s, 'codex_device_context')).toBe(0); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses an extension older than the device-handoff floor', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.contacts.markExtensionRuntime('browser', runtime(100, '0.2.51'));
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a tab whose extension install has no registered runtime', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.resolveTarget.mockImplementationOnce(async () => ({ browserNodeId: 'browser', browserProfileId: fill.profileId,
        targetId: fill.targetId, tabId: 1, extensionInstanceId: 'unregistered-install', extensionGeneration: '100',
        computerName: 'Browser', isCurrent: () => true }));
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses while secret-observation protection is off', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.protectionEnabled.mockReturnValue(false);
      await expectRefused(s.controller.fill(fill, owner));
      expect(count(s, 'codex_device_context')).toBe(0); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses a page whose origin or identity the extension rejects', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.commands.sendCommand.mockImplementationOnce(async () => { throw new Error(`wrong origin ${CODE}`); });
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expectNoRelease(s);
      // The failed operation is spent: a retry cannot start a second attempt.
      await expectRefused(s.controller.fill(fill, owner));
      expect(count(s, 'codex_device_context')).toBe(1); s.controller.shutdown();
    });
    it('refuses a page whose identity does not match', async () => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.commands.sendCommand.mockResolvedValueOnce({ documentId, extensionInstanceId: 'test-install',
        extensionGeneration: '100', identityMatches: false });
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expectNoRelease(s); s.controller.shutdown();
    });
  });

  describe('native operation state', () => {
    it.each(['authenticated', 'failed', 'cancelled', 'expired', 'awaiting_login', 'verifying'] as const)(
      'refuses to start from a native view that is already %s (existing sign-in, mismatch or ended login)', async state => {
        const s = setup(); s.deps.worker.request.mockResolvedValueOnce({ ...s.view, state });
        await expectRefused(s.controller.start(native, owner));
        expect(sent(s)).toEqual([]); s.controller.shutdown();
      });
    it.each(['authenticated', 'failed', 'expired'] as const)('never fills once a read reports %s', async state => {
      const s = setup(); await s.controller.start(native, owner);
      s.deps.worker.request.mockResolvedValueOnce({ ...s.view, state });
      expect(await s.controller.read(handle, owner)).toMatchObject({ state });
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.deps.approvals.createRequest).not.toHaveBeenCalled(); expect(sent(s)).toEqual([]); s.controller.shutdown();
    });
    it('never fills a cancelled login, before or after approval', async () => {
      const s = setup(); await s.approved();
      expect(await s.controller.cancel(handle, owner)).toMatchObject({ state: 'cancelled' });
      expect(s.requests.get('approval')!.status).toBe('expired');
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s);
      const t = setup(); await t.controller.start(native, owner); await t.controller.cancel(handle, owner);
      await expectRefused(t.controller.fill(fill, owner)); expect(sent(t)).toEqual([]);
      s.controller.shutdown(); t.controller.shutdown();
    });
    it('never fills after the native lifetime ends, even with an approval on file', async () => {
      const s = setup(); await s.approved();
      await vi.advanceTimersByTimeAsync(60_000);
      await expectRefused(s.controller.fill(fill, owner));
      expect(s.requests.get('approval')!.status).toBe('expired'); expectNoRelease(s); s.controller.shutdown();
    });
  });

  describe('approval', () => {
    it('refuses an approval replaced by another request', async () => {
      const s = setup(); await s.approved();
      s.deps.approvals.findDeviceLoginRequest.mockReturnValue({ ...s.requests.get('approval')!, requestId: 'approval-2', id: 'approval-2' });
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses an approval whose expiry no longer matches the native operation', async () => {
      const s = setup(); await s.approved();
      s.requests.get('approval')!.expiresAt += 1_000;
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s); s.controller.shutdown();
    });
    it('refuses an approval that was withdrawn after it was given', async () => {
      const s = setup(); await s.approved();
      s.requests.get('approval')!.status = 'denied';
      await expectRefused(s.controller.fill(fill, owner)); expectNoRelease(s); s.controller.shutdown();
    });
  });

  describe('during the fill', () => {
    /** Runs the approved fill, letting `during` change the world while the code write is in flight. */
    async function fillWhile(s: Setup, during: (original: (request: BrowserExtensionSendCommandRequest) => Promise<unknown>,
      request: BrowserExtensionSendCommandRequest) => Promise<unknown>) {
      await s.approved();
      const original = s.deps.commands.sendCommand.getMockImplementation()!;
      s.deps.commands.sendCommand.mockImplementation(request => request.command === 'codex_device_fill'
        ? during(original, request) : original(request));
      return s.controller.fill(fill, owner);
    }
    it('never submits when the extension restarts during the write', async () => {
      const s = setup();
      await expectRefused(fillWhile(s, async (original, request) => {
        s.deps.contacts.markExtensionRuntime('browser', runtime(200)); return original(request);
      }));
      expect(count(s, 'codex_device_fill')).toBe(1); expect(count(s, 'codex_device_submit')).toBe(0);
      s.controller.shutdown();
    });
    it('never submits when the approval goes stale during the write', async () => {
      const s = setup();
      await expectRefused(fillWhile(s, async (original, request) => {
        s.requests.get('approval')!.status = 'expired'; return original(request);
      }));
      expect(count(s, 'codex_device_submit')).toBe(0); s.controller.shutdown();
    });
    it('never submits when the shared tab leaves its origin during the write', async () => {
      const s = setup(); let current = true;
      s.deps.resolveTarget.mockImplementation(async () => ({ browserNodeId: 'browser', browserProfileId: fill.profileId,
        targetId: fill.targetId, tabId: 1, extensionInstanceId: 'test-install', extensionGeneration: '100', computerName: 'Browser',
        isCurrent: () => current }));
      await expectRefused(fillWhile(s, async (original, request) => { current = false; return original(request); }));
      expect(count(s, 'codex_device_submit')).toBe(0); s.controller.shutdown();
    });
    it.each([
      ['an unverified fill', { completed: false }],
      ['a partial fill reporting extra detail', { completed: true, filled: 4 }],
      ['no result', undefined],
    ])('never submits after %s', async (_label, result) => {
      const s = setup();
      await expectRefused(fillWhile(s, async () => result));
      expect(count(s, 'codex_device_submit')).toBe(0);
      // The failed operation cannot be retried into a second write or a second native handoff.
      await expectRefused(s.controller.fill(fill, owner));
      expect(count(s, 'codex_device_fill')).toBe(1); expect(handoffs(s)).toBe(1); s.controller.shutdown();
    });
    it('keeps a thrown, code-bearing extension error out of the result', async () => {
      const s = setup();
      await expectRefused(fillWhile(s, async () => { throw new Error(`write failed for ${CODE}`); }));
      expect(count(s, 'codex_device_submit')).toBe(0); s.controller.shutdown();
    });
    it('cancels the native login when the fill fails and refuses any retry of the same handle', async () => {
      const s = setup();
      await expectRefused(fillWhile(s, async () => ({ completed: false })));
      expect(s.deps.worker.request.mock.calls.some(call => call[1].endsWith('.cancel'))).toBe(true);
      await expectRefused(s.controller.fill(fill, owner));
      expect(handoffs(s)).toBe(1); s.controller.shutdown();
    });
    it('refuses a reentrant fill and still submits exactly once', async () => {
      const s = setup(); let inner: Promise<unknown> | undefined;
      const outer = fillWhile(s, async (original, request) => {
        inner = s.controller.fill(fill, owner); return original(request);
      });
      await expect(outer).resolves.toMatchObject({ status: 'submitted' });
      await expectRefused(inner!);
      expect(count(s, 'codex_device_fill')).toBe(1); expect(count(s, 'codex_device_submit')).toBe(1); expect(handoffs(s)).toBe(1);
      s.controller.shutdown();
    });
  });

  describe('after a successful submit', () => {
    it('consumes the handle: a duplicate fill neither writes nor submits again', async () => {
      const s = setup(); await s.approved();
      const first = await s.controller.fill(fill, owner);
      expect(first).toMatchObject({ status: 'submitted', operation: { state: 'awaiting_login' } });
      expect(JSON.stringify(first)).not.toContain(CODE);
      await expectRefused(s.controller.fill(fill, owner));
      await expectRefused(s.controller.fill(fill, owner));
      expect(count(s, 'codex_device_fill')).toBe(1); expect(count(s, 'codex_device_submit')).toBe(1); expect(handoffs(s)).toBe(1);
      s.controller.shutdown();
    });
    it('does not start a second login for the same profile while the first is live', async () => {
      const s = setup(); await s.approved(); await s.controller.fill(fill, owner);
      await expectRefused(s.controller.start(native, owner));
      expect(s.deps.worker.request.mock.calls.filter(call => call[1].endsWith('.start'))).toHaveLength(1);
      s.controller.shutdown();
    });
  });
});
