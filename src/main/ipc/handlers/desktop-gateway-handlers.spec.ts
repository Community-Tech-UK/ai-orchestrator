import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopGatewayResult,
  DesktopPermissionRepairResult,
  DesktopPermissionRequestResult,
} from '../../../shared/types/desktop-gateway.types';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  openExternal: vi.fn(async (_url: string) => undefined),
  repairSystemPermissions: vi.fn(async (): Promise<DesktopPermissionRepairResult> => ({
    resetPermissions: ['screen-recording', 'accessibility'],
    relaunchRequired: true,
  })),
  scheduleRelaunch: vi.fn(),
  health: vi.fn(async () => ({
    decision: 'allowed' as const,
    outcome: 'ok' as const,
    data: { enabled: true },
  })),
  requestSystemPermissionForOperator:
    vi.fn(async (_permission: string): Promise<DesktopGatewayResult<DesktopPermissionRequestResult>> => ({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        permission: 'screen-recording',
        state: 'missing_permission',
        nativeRequestAttempted: true,
      },
    })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
  },
  shell: {
    openExternal: mocks.openExternal,
  },
}));

vi.mock('../../desktop-gateway/desktop-gateway-service', () => ({
  getDesktopGatewayService: () => ({
    requestSystemPermissionForOperator: mocks.requestSystemPermissionForOperator,
    health: mocks.health,
    listApps: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
    listGrantsForOperator: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
    revokeGrantForOperator: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
    getAuditLogForOperator: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
  }),
}));

import { registerDesktopGatewayHandlers } from './desktop-gateway-handlers';

const CHANNEL = 'desktop:request-system-permission';
const REPAIR_CHANNEL = 'desktop:repair-system-permissions';
const RELAUNCH_CHANNEL = 'desktop:relaunch-application';

interface HandlerResponse {
  success: boolean;
  data?: DesktopGatewayResult<
    DesktopPermissionRequestResult & { settingsOpened?: boolean }
  >;
  error?: { code?: string };
}

function invoke(payload: unknown): Promise<HandlerResponse> {
  return invokeChannel(CHANNEL, payload) as Promise<HandlerResponse>;
}

function invokeChannel(channel: string, payload: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({}, payload) as Promise<HandlerResponse>;
}

function operatorResult(
  data: DesktopPermissionRequestResult,
): DesktopGatewayResult<DesktopPermissionRequestResult> {
  return { decision: 'allowed', outcome: 'ok', data };
}

describe('desktop-gateway-handlers request-system-permission', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('rejects arbitrary permission values before any native request or navigation', async () => {
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'full-disk-access' });

    expect(response.success).toBe(false);
    expect(mocks.requestSystemPermissionForOperator).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('rejects a renderer-supplied URL field via the strict schema', async () => {
    registerDesktopGatewayHandlers();

    const response = await invoke({
      permission: 'accessibility',
      url: 'x-apple.systempreferences:attacker-pane',
    });

    expect(response.success).toBe(false);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('rejects untrusted senders before any native request or navigation', async () => {
    registerDesktopGatewayHandlers({
      ensureTrustedSender: () => ({
        success: false,
        error: { code: 'UNTRUSTED_SENDER', message: 'untrusted', timestamp: 0 },
      }),
    });

    const response = await invoke({ permission: 'screen-recording' });

    expect(response.success).toBe(false);
    expect(mocks.requestSystemPermissionForOperator).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('does not open System Settings when the permission is already ready', async () => {
    mocks.requestSystemPermissionForOperator.mockResolvedValueOnce(operatorResult({
      permission: 'screen-recording',
      state: 'available',
      nativeRequestAttempted: false,
    }));
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'screen-recording' });

    expect(response.success).toBe(true);
    expect(response.data?.data).toEqual({
      permission: 'screen-recording',
      state: 'available',
      nativeRequestAttempted: false,
      settingsOpened: false,
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('opens the exact pane after a native request leaves the permission missing', async () => {
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'screen-recording' });

    expect(response.success).toBe(true);
    expect(response.data?.data?.settingsOpened).toBe(true);
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('returns the denied gateway result untouched when the service denies', async () => {
    mocks.requestSystemPermissionForOperator.mockResolvedValueOnce({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_disabled',
    });
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'accessibility' });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      decision: 'denied',
      reason: 'computer_use_disabled',
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('falls back to the Privacy & Security root when the exact pane fails', async () => {
    mocks.requestSystemPermissionForOperator.mockResolvedValueOnce(operatorResult({
      permission: 'accessibility',
      state: 'missing_permission',
      nativeRequestAttempted: true,
    }));
    mocks.openExternal
      .mockRejectedValueOnce(new Error('pane rejected'))
      .mockResolvedValueOnce(undefined);
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'accessibility' });

    expect(response.data?.data?.settingsOpened).toBe(true);
    expect(mocks.openExternal).toHaveBeenNthCalledWith(
      1,
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    expect(mocks.openExternal).toHaveBeenNthCalledWith(
      2,
      'x-apple.systempreferences:com.apple.preference.security',
    );
  });

  it('reports dual navigation failure truthfully while preserving the native result', async () => {
    mocks.requestSystemPermissionForOperator.mockResolvedValueOnce(operatorResult({
      permission: 'accessibility',
      state: 'missing_permission',
      nativeRequestAttempted: true,
    }));
    mocks.openExternal.mockRejectedValue(new Error('no settings app'));
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'accessibility' });

    expect(response.success).toBe(true);
    expect(response.data?.data).toEqual({
      permission: 'accessibility',
      state: 'missing_permission',
      nativeRequestAttempted: true,
      settingsOpened: false,
    });
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it('never opens macOS URLs for an unsupported-platform result', async () => {
    mocks.requestSystemPermissionForOperator.mockResolvedValueOnce(operatorResult({
      permission: 'screen-recording',
      state: 'unsupported',
      nativeRequestAttempted: false,
    }));
    registerDesktopGatewayHandlers();

    const response = await invoke({ permission: 'screen-recording' });

    expect(response.data?.data).toMatchObject({
      state: 'unsupported',
      settingsOpened: false,
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('uses the injected openExternal seam when provided', async () => {
    const openExternal = vi.fn(async () => undefined);
    registerDesktopGatewayHandlers({ openExternal });

    await invoke({ permission: 'screen-recording' });

    expect(openExternal).toHaveBeenCalledOnce();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

describe('desktop-gateway-handlers permission repair', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('runs the fixed main-process repair and returns its relaunch requirement', async () => {
    registerDesktopGatewayHandlers({
      repairSystemPermissions: mocks.repairSystemPermissions,
      scheduleRelaunch: mocks.scheduleRelaunch,
    });

    const response = await invokeChannel(REPAIR_CHANNEL, {});

    expect(mocks.repairSystemPermissions).toHaveBeenCalledOnce();
    expect(response).toEqual({
      success: true,
      data: {
        resetPermissions: ['screen-recording', 'accessibility'],
        relaunchRequired: true,
      },
    });
  });

  it('rejects renderer-supplied repair targets before touching TCC', async () => {
    registerDesktopGatewayHandlers({
      repairSystemPermissions: mocks.repairSystemPermissions,
    });

    const response = await invokeChannel(REPAIR_CHANNEL, {
      service: 'All',
      bundleId: 'com.apple.Terminal',
    }) as HandlerResponse;

    expect(response.success).toBe(false);
    expect(mocks.repairSystemPermissions).not.toHaveBeenCalled();
  });

  it('does not reset permissions while Computer Use is disabled', async () => {
    mocks.health.mockResolvedValueOnce({
      decision: 'allowed',
      outcome: 'ok',
      data: { enabled: false },
    });
    registerDesktopGatewayHandlers({
      repairSystemPermissions: mocks.repairSystemPermissions,
    });

    const response = await invokeChannel(REPAIR_CHANNEL, {}) as HandlerResponse;

    expect(response.success).toBe(false);
    expect(mocks.repairSystemPermissions).not.toHaveBeenCalled();
  });

  it('schedules an app relaunch only from the dedicated empty-payload action', async () => {
    registerDesktopGatewayHandlers({
      repairSystemPermissions: mocks.repairSystemPermissions,
      scheduleRelaunch: mocks.scheduleRelaunch,
    });

    const response = await invokeChannel(RELAUNCH_CHANNEL, {});

    expect(response).toEqual({ success: true, data: { relaunching: true } });
    expect(mocks.scheduleRelaunch).toHaveBeenCalledOnce();
  });
});
