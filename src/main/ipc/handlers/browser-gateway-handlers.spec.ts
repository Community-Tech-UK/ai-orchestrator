import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { RedeliveryContext } from '../../session/session-admission-service';

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

const mocks = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn(() => ({ kind: 'admitted' as const, admissionId: 'admission-1' })),
  approveRequest: vi.fn(async () => ({
    decision: 'allowed',
    outcome: 'succeeded',
    data: { instanceId: 'inst-1' },
  })),
  denyRequest: vi.fn(async () => ({
    decision: 'allowed',
    outcome: 'succeeded',
    data: { instanceId: 'inst-1' },
  })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  registerRedeliveryHandler: vi.fn<(origin: string, handler: (ctx: RedeliveryContext) => void) => void>(),
  getApprovalRequest: vi.fn(),
  listTargets: vi.fn(),
  secretRecoveryCompletion: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}));

vi.mock('../../browser-gateway/browser-gateway-service', () => ({
  getBrowserGatewayService: () => ({
    approveRequest: mocks.approveRequest,
    denyRequest: mocks.denyRequest,
    getApprovalRequest: mocks.getApprovalRequest,
    listTargets: mocks.listTargets,
    secretRecoveryCompletion: mocks.secretRecoveryCompletion,
  }),
}));

vi.mock('../../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    admitAutomatedWrite: mocks.admitAutomatedWrite,
    markDelivered: mocks.markDelivered,
    markFailed: mocks.markFailed,
    registerRedeliveryHandler: mocks.registerRedeliveryHandler,
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerBrowserGatewayHandlers } from './browser-gateway-handlers';
import { resolveCredentialAccessSession, findCredentialAccessSession, notifyCredentialAccessDecision } from '../../browser-gateway/browser-credential-access-session';
import { BrowserDeviceLoginCapability, setBrowserDeviceLoginCapabilityProvider } from '../../browser-gateway/browser-device-login-capability';

describe('Browser Gateway approval resume admission', () => {
  const sendInput = vi.fn(async () => undefined);
  afterEach(() => setBrowserDeviceLoginCapabilityProvider(null));

  beforeEach(() => {
    setBrowserDeviceLoginCapabilityProvider(null);
    handlers.clear();
    vi.clearAllMocks();
    mocks.approveRequest.mockReset().mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', data: { instanceId: 'inst-1' } });
    mocks.getApprovalRequest.mockReset();
    registerBrowserGatewayHandlers({
      instanceManager: { sendInput } as never,
    });
  });

  function deviceDecision() {
    const capabilities = new BrowserDeviceLoginCapability(id => id === 'inst-1');
    setBrowserDeviceLoginCapabilityProvider(capabilities);
    const token = capabilities.mint('inst-1');
    const deviceLogin = { ownerSessionId: 'inst-1', ownerGeneration: capabilities.verify('inst-1', token), expiresAt: Date.now() + 60_000 };
    mocks.approveRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded', data: null } as never);
    mocks.getApprovalRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded',
      data: { instanceId: 'inst-1', status: 'approved', deviceLogin } });
    const payload = { requestId: 'device-request', deviceLogin: { permission: 'operation' },
      grant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'auth.openai.com', includeSubdomains: false }], allowedActionClasses: ['credential'],
        allowExternalNavigation: false, autonomous: false } };
    return { capabilities, deviceLogin, payload };
  }

  describe('browser access recovery', () => {
    const payload = { requestId: 'recovery-request', secretRecovery: { permission: 'operation' },
      grant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'site.example', includeSubdomains: false }],
        allowedActionClasses: ['read'], allowExternalNavigation: false, autonomous: false } };
    function finished(state: string, receiptId?: string) {
      return { requestId: 'recovery-request', instanceId: 'inst-1', status: 'approved',
        secretRecovery: { operationId: 'op' },
        secretRecoveryProgress: { state, reasonCode: 'code_test_only', loginVerified: null, updatedAt: 1, ...(receiptId ? { receiptId } : {}) } };
    }

    it('wakes the asking session only after Harness has finished, with fixed words', async () => {
      mocks.approveRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded', data: null } as never);
      let finish!: (value: unknown) => void;
      mocks.secretRecoveryCompletion.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      expect(await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload)).toMatchObject({ success: true });
      // Approval alone wakes nobody.
      expect(sendInput).not.toHaveBeenCalled();
      finish(finished('recovered', 'op'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('inst-1',
        'Browser access recovery recovery-request finished: recovered (code_test_only). '
        + 'Call browser.recover_secret_observation again with this requestId for the result and next step.',
        undefined, { automatedInput: true, internalSource: 'browser-gateway' });
    });

    it('wakes the session for a recovery that already stopped before the handler asked', async () => {
      mocks.approveRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded', data: null } as never);
      mocks.secretRecoveryCompletion.mockReturnValueOnce(Promise.resolve(finished('stale_review')));
      await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendInput).toHaveBeenCalledOnce();
    });

    it('does not wake a session that was stopped while its recovery ran', async () => {
      mocks.approveRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded', data: null } as never);
      mocks.secretRecoveryCompletion.mockReturnValueOnce(Promise.resolve({ ...finished('recovered', 'op'), status: 'expired' }));
      await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendInput).not.toHaveBeenCalled();
    });

    it('does not wake anyone when the recovery approval was not applied', async () => {
      mocks.approveRequest.mockResolvedValueOnce({ decision: 'denied', outcome: 'not_run', data: null } as never);
      await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mocks.secretRecoveryCompletion).not.toHaveBeenCalled();
      expect(sendInput).not.toHaveBeenCalled();
    });
  });

  it('still gives Harness\'s own screen the full tab listing (only agents get the compact one)', async () => {
    const fullTarget = {
      id: 'target-1',
      targetId: 'target-1',
      profileId: 'profile-1',
      pageId: 'page-1',
      driver: 'extension',
      windowId: 7,
      tabIndex: 2,
      pinned: false,
      lastSeenAt: 1_700_000_000_000,
      lastConfirmedAt: 1_700_000_000_001,
    };
    mocks.listTargets.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded', data: [fullTarget] });

    const response = await handlers.get(IPC_CHANNELS.BROWSER_LIST_TARGETS)?.({}, {});

    expect(response).toMatchObject({ success: true, data: { data: [fullTarget] } });
  });

  it('wakes the exact device-login owner after approval without a reusable grant', async () => {
    const { deviceLogin, payload } = deviceDecision();
    expect(await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload)).toMatchObject({ success: true });
    expect(sendInput).toHaveBeenCalledOnce();
    expect(mocks.admitAutomatedWrite).toHaveBeenCalledWith(expect.objectContaining({
      sourceMetadata: { decision: 'approved', requestId: 'device-request', deviceLogin },
    }));
  });

  it('does not wake a replacement owner for an old device approval', async () => {
    const { capabilities, payload } = deviceDecision();
    capabilities.mint('inst-1');
    expect(await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload)).toMatchObject({ success: true });
    expect(sendInput).not.toHaveBeenCalled();
    expect(mocks.admitAutomatedWrite).not.toHaveBeenCalled();
  });

  it.each(['restart', 'expiry'] as const)('drops delayed device approval wake after %s', async change => {
    const { capabilities, deviceLogin } = deviceDecision();
    if (change === 'restart') capabilities.mint('inst-1');
    else deviceLogin.expiresAt = Date.now() - 1;
    const redeliver = mocks.registerRedeliveryHandler.mock.calls[0]![1];
    redeliver({ instanceId: 'inst-1', admissionId: 'device-admission', message: 'Approved', sourceMetadata: { deviceLogin } });
    expect(sendInput).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith('device-admission', 'device_login_owner_no_longer_current');
  });

  it('delivers a deferred device decision when its original owner is still current', async () => {
    const { deviceLogin } = deviceDecision();
    const redeliver = mocks.registerRedeliveryHandler.mock.calls[0]![1];
    redeliver({ instanceId: 'inst-1', admissionId: 'device-admission', message: 'Approved', sourceMetadata: { deviceLogin } });
    await Promise.resolve();
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('inst-1', 'Approved', undefined,
      { automatedInput: true, internalSource: 'browser-gateway' });
    expect(mocks.markDelivered).toHaveBeenCalledWith('device-admission');
  });

  it('checks ownership again if admission changes the session before delivery', async () => {
    const { capabilities, payload } = deviceDecision();
    mocks.admitAutomatedWrite.mockImplementationOnce(() => {
      capabilities.mint('inst-1');
      return { kind: 'admitted', admissionId: 'device-admission' };
    });
    expect(await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, payload)).toMatchObject({ success: true });
    expect(sendInput).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith('device-admission', 'device_login_owner_no_longer_current');
  });

  it.each([false, true])('checks device denial ownership after restart=%s', async restarted => {
    const { capabilities, deviceLogin } = deviceDecision();
    mocks.denyRequest.mockResolvedValueOnce({ decision: 'allowed', outcome: 'succeeded',
      data: { instanceId: 'inst-1', deviceLogin } } as never);
    if (restarted) capabilities.mint('inst-1');
    expect(await handlers.get(IPC_CHANNELS.BROWSER_DENY_REQUEST)?.({}, { requestId: 'device-request' }))
      .toMatchObject({ success: true });
    expect(sendInput).toHaveBeenCalledTimes(restarted ? 0 : 1);
  });

  it('requires a ready lifecycle and idle provider runtime before sending the resume nudge', async () => {
    const handler = handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST);
    expect(handler).toBeDefined();

    await handler?.({}, {
      requestId: 'request-1',
      grant: {
        mode: 'per_action',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'example.test',
          includeSubdomains: false,
        }],
        allowedActionClasses: ['submit'],
        allowExternalNavigation: false,
        autonomous: true,
      },
    });

    expect(mocks.admitAutomatedWrite).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      origin: 'browser-gateway',
      requireReadyForInput: true,
      coalesceKey: 'browser-approval-resume:request-1',
      message: expect.stringMatching(/request-1.*approved/i),
    }));
  });

  it('applies the same strict coalescing contract to denial resumptions', async () => {
    const handler = handlers.get(IPC_CHANNELS.BROWSER_DENY_REQUEST);
    expect(handler).toBeDefined();

    await handler?.({}, { requestId: 'request-2' });

    expect(mocks.admitAutomatedWrite).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      origin: 'browser-gateway',
      requireReadyForInput: true,
      coalesceKey: 'browser-approval-resume:request-2',
      message: expect.stringMatching(/request-2.*denied/i),
    }));
  });

  it('does not wake a session when credential enrolment failed after IPC delivery', async () => {
    mocks.approveRequest.mockResolvedValueOnce({
      decision: 'allowed', outcome: 'failed', data: { instanceId: 'inst-1' },
    } as never);
    await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, {
      requestId: 'request-1', grant: {
        mode: 'per_action', allowedOrigins: [], allowedActionClasses: ['credential'],
        allowExternalNavigation: false, autonomous: false,
      }, credentialAccess: { permission: 'task' },
    });
    expect(sendInput).not.toHaveBeenCalled();
    expect(mocks.admitAutomatedWrite).not.toHaveBeenCalled();
  });

  it('uses trusted conversation identity to find the current live owner after a session resumes', () => {
    const instances = [
      { id: 'old-session', historyThreadId: 'placeholder-thread', displayName: '12steps', status: 'terminated' },
      { id: 'resumed-session', historyThreadId: 'placeholder-thread', displayName: '12steps', status: 'idle' },
    ];
    registerBrowserGatewayHandlers({ instanceManager: {
      sendInput,
      getInstance: (id: string) => instances.find((instance) => instance.id === id),
      getAllInstances: () => instances,
    } as never });
    expect(resolveCredentialAccessSession('old-session')).toBeUndefined();
    expect(resolveCredentialAccessSession('resumed-session')).toEqual({
      instanceId: 'resumed-session', taskScope: 'conversation:placeholder-thread', sessionName: '12steps',
    });
    expect(findCredentialAccessSession('conversation:placeholder-thread', 'old-session')?.instanceId).toBe('resumed-session');
    instances.push({ id: 'duplicate-session', historyThreadId: 'placeholder-thread', displayName: '12steps', status: 'idle' });
    expect(findCredentialAccessSession('conversation:placeholder-thread', 'old-session')).toBeUndefined();
  });

  it.each(['approved', 'denied', 'expired'] as const)(
    'wakes the resumed owner when the shared service records %s', async (status) => {
      const instance = { id: 'resumed-session', historyThreadId: 'placeholder-thread', displayName: '12steps', status: 'idle' };
      registerBrowserGatewayHandlers({ instanceManager: {
        sendInput, getInstance: () => instance, getAllInstances: () => [instance],
      } as never });
      await notifyCredentialAccessDecision({
        requestId: 'placeholder-request', instanceId: 'old-session', status,
        credentialAccess: { taskScope: 'conversation:placeholder-thread' },
      } as Parameters<typeof notifyCredentialAccessDecision>[0]);
      expect(sendInput).toHaveBeenCalledOnce();
      expect(sendInput).toHaveBeenCalledWith('resumed-session', expect.stringContaining(status), undefined,
        { automatedInput: true, internalSource: 'browser-gateway' });
    },
  );

  it.each(['saved_login_access_approved', 'saved_login_preapproved_by_setting'])(
    'does not send a second wake after the shared credential service already owns notification (%s)', async (reason) => {
    mocks.approveRequest.mockResolvedValueOnce({
      decision: 'allowed', outcome: 'succeeded', data: { instanceId: 'inst-1', reason },
    } as never);
    await handlers.get(IPC_CHANNELS.BROWSER_APPROVE_REQUEST)?.({}, {
      requestId: 'request-1', grant: {
        mode: 'per_action', allowedOrigins: [], allowedActionClasses: ['credential'],
        allowExternalNavigation: false, autonomous: false,
      }, credentialAccess: { permission: 'task' },
    });
    expect(sendInput).not.toHaveBeenCalled();
    expect(mocks.admitAutomatedWrite).not.toHaveBeenCalled();
  },
  );
});
