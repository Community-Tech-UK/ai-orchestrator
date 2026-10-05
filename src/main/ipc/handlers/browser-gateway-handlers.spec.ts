import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';

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
  registerRedeliveryHandler: vi.fn(),
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

describe('Browser Gateway approval resume admission', () => {
  const sendInput = vi.fn(async () => undefined);

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerBrowserGatewayHandlers({
      instanceManager: { sendInput } as never,
    });
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
    expect(findCredentialAccessSession('conversation:placeholder-thread')?.instanceId).toBe('resumed-session');
    instances.push({ id: 'duplicate-session', historyThreadId: 'placeholder-thread', displayName: '12steps', status: 'idle' });
    expect(findCredentialAccessSession('conversation:placeholder-thread')).toBeUndefined();
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

  it('does not send a second wake after the shared credential service already owns notification', async () => {
    mocks.approveRequest.mockResolvedValueOnce({
      decision: 'allowed', outcome: 'succeeded', data: { instanceId: 'inst-1', reason: 'saved_login_access_approved' },
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
});
