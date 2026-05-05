import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const serviceMocks = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  openProfile: vi.fn(),
  closeProfile: vi.fn(),
  listTargets: vi.fn(),
  selectTarget: vi.fn(),
  refreshExistingTab: vi.fn(),
  navigate: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  fillForm: vi.fn(),
  select: vi.fn(),
  uploadFile: vi.fn(),
  requestUserLogin: vi.fn(),
  pauseForManualStep: vi.fn(),
  requestGrant: vi.fn(),
  getApprovalStatus: vi.fn(),
  listApprovalRequests: vi.fn(),
  getApprovalRequest: vi.fn(),
  approveRequest: vi.fn(),
  denyRequest: vi.fn(),
  createGrant: vi.fn(),
  listGrants: vi.fn(),
  revokeGrant: vi.fn(),
  snapshot: vi.fn(),
  screenshot: vi.fn(),
  consoleMessages: vi.fn(),
  networkRequests: vi.fn(),
  waitFor: vi.fn(),
  getAuditLog: vi.fn(),
  getHealth: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../browser-gateway/browser-gateway-service', () => ({
  getBrowserGatewayService: () => serviceMocks,
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { registerBrowserGatewayHandlers } from '../browser-gateway-handlers';

const fakeEvent = {};

describe('registerBrowserGatewayHandlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
    for (const mock of Object.values(serviceMocks)) {
      mock.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', auditId: 'audit-1' });
    }
    registerBrowserGatewayHandlers();
  });

  it('validates payloads before calling the service', async () => {
    const result = await invoke('browser:navigate', {
      profileId: 'profile-1',
      targetId: 'target-1',
    });

    expect(result.success).toBe(false);
    expect(serviceMocks.navigate).not.toHaveBeenCalled();
  });

  it('calls the matching Browser Gateway service method once for valid payloads', async () => {
    const payload = {
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567',
    };

    const result = await invoke('browser:navigate', payload);

    expect(result).toMatchObject({
      success: true,
      data: { decision: 'allowed', outcome: 'succeeded' },
    });
    expect(serviceMocks.navigate).toHaveBeenCalledTimes(1);
    expect(serviceMocks.navigate).toHaveBeenCalledWith(payload);
  });

  it('registers the existing-tab refresh channel', async () => {
    const payload = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
    };

    const result = await invoke('browser:refresh-existing-tab', payload);

    expect(result).toMatchObject({
      success: true,
      data: { decision: 'allowed', outcome: 'succeeded' },
    });
    expect(serviceMocks.refreshExistingTab).toHaveBeenCalledWith(payload);
  });

  it('registers mutating browser actions and approval/grant channels', async () => {
    const clickPayload = {
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
    };
    const approvePayload = {
      requestId: 'request-1',
      grant: {
        mode: 'session',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    };

    await expect(invoke('browser:click', clickPayload)).resolves.toMatchObject({
      success: true,
    });
    await expect(invoke('browser:approve-request', approvePayload)).resolves.toMatchObject({
      success: true,
    });
    expect(serviceMocks.click).toHaveBeenCalledWith(clickPayload);
    expect(serviceMocks.approveRequest).toHaveBeenCalledWith(approvePayload);
  });

  it('registers human handoff browser channels', async () => {
    const loginPayload = {
      profileId: 'profile-1',
      targetId: 'target-1',
      reason: 'User needs to sign in before automation can continue.',
    };
    const manualPayload = {
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'captcha',
      reason: 'Complete the CAPTCHA challenge.',
    };

    await expect(invoke('browser:request-user-login', loginPayload)).resolves.toMatchObject({
      success: true,
    });
    await expect(invoke('browser:pause-for-manual-step', manualPayload)).resolves.toMatchObject({
      success: true,
    });

    expect(serviceMocks.requestUserLogin).toHaveBeenCalledWith(loginPayload);
    expect(serviceMocks.pauseForManualStep).toHaveBeenCalledWith(manualPayload);
  });

  it('returns success false when the service throws', async () => {
    serviceMocks.getHealth.mockRejectedValueOnce(new Error('gateway unavailable'));

    const result = await invoke('browser:get-health', {});

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'BROWSER_GATEWAY_FAILED',
        message: 'gateway unavailable',
      },
    });
  });

  it('can reject untrusted senders before validating or calling the service', async () => {
    electronMocks.handlers.clear();
    registerBrowserGatewayHandlers({
      ensureTrustedSender: vi.fn(() => ({
        success: false,
        error: {
          code: 'IPC_TRUST_FAILED',
          message: 'untrusted sender',
          timestamp: 1,
        },
      })),
    });

    const result = await invoke('browser:approve-request', {
      requestId: 'request-1',
      grant: {
        mode: 'session',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'IPC_TRUST_FAILED',
      },
    });
    expect(serviceMocks.approveRequest).not.toHaveBeenCalled();
  });
});

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(fakeEvent, payload);
}
