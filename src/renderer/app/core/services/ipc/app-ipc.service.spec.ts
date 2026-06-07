import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { AppIpcService } from './app-ipc.service';

describe('AppIpcService', () => {
  const api = {
    stateResync: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.stateResync.mockResolvedValue({
      success: true,
      data: {
        instances: [],
        loopRuns: [],
        automationRuns: [],
        pauseState: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
        memoryPressure: 'normal',
        seq: 7,
      },
    });

    TestBed.configureTestingModule({
      providers: [
        AppIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => api,
          },
        },
      ],
    });
  });

  it('delegates state resync to the preload API', async () => {
    const service = TestBed.inject(AppIpcService);

    const response = await service.stateResync();

    expect(api.stateResync).toHaveBeenCalledOnce();
    expect(response.success).toBe(true);
    expect(response.data?.seq).toBe(7);
  });
});
