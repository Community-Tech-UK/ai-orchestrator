import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { DesktopGatewayIpcService } from './desktop-gateway-ipc.service';

describe('DesktopGatewayIpcService', () => {
  const api = {
    desktopGetHealth: vi.fn(),
    desktopRequestSystemPermission: vi.fn(),
  };
  let currentApi: typeof api | null = api;

  beforeEach(() => {
    vi.clearAllMocks();
    currentApi = api;

    TestBed.configureTestingModule({
      providers: [
        DesktopGatewayIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => currentApi,
          },
        },
      ],
    });
  });

  it('forwards the typed permission payload and normalizes the nested gateway result', async () => {
    api.desktopRequestSystemPermission.mockResolvedValue({
      success: true,
      data: {
        decision: 'allowed',
        outcome: 'ok',
        data: {
          permission: 'screen-recording',
          state: 'missing_permission',
          nativeRequestAttempted: true,
          settingsOpened: true,
        },
      },
    });
    const service = TestBed.inject(DesktopGatewayIpcService);

    const response = await service.requestSystemPermission('screen-recording');

    expect(api.desktopRequestSystemPermission).toHaveBeenCalledExactlyOnceWith({
      permission: 'screen-recording',
    });
    expect(response.success).toBe(true);
    expect(response.data?.data).toEqual({
      permission: 'screen-recording',
      state: 'missing_permission',
      nativeRequestAttempted: true,
      settingsOpened: true,
    });
  });

  it('returns the denied gateway result unchanged', async () => {
    api.desktopRequestSystemPermission.mockResolvedValue({
      success: true,
      data: {
        decision: 'denied',
        outcome: 'not_run',
        reason: 'computer_use_disabled',
      },
    });
    const service = TestBed.inject(DesktopGatewayIpcService);

    const response = await service.requestSystemPermission('accessibility');

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      decision: 'denied',
      reason: 'computer_use_disabled',
    });
  });

  it('normalizes the non-Electron case to a typed failure', async () => {
    currentApi = null;
    const service = TestBed.inject(DesktopGatewayIpcService);

    const response = await service.requestSystemPermission('accessibility');

    expect(response).toEqual({
      success: false,
      error: { message: 'Not in Electron' },
    });
  });
});
