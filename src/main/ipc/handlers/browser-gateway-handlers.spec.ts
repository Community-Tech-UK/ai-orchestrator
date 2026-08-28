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
      coalesceKey: 'browser-approval-resume',
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
      coalesceKey: 'browser-approval-resume',
      message: expect.stringMatching(/request-2.*denied/i),
    }));
  });
});
