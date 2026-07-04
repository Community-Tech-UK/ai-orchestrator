import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { ModelIpcService } from './model-ipc.service';

describe('ModelIpcService', () => {
  let api: {
    modelDiscover: ReturnType<typeof vi.fn>;
    modelVerify: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      modelDiscover: vi.fn(),
      modelVerify: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ModelIpcService,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
      ],
    });
  });

  it('wraps raw legacy model discovery arrays in an IPC response', async () => {
    api.modelDiscover.mockResolvedValueOnce([{ id: 'opus', provider: 'claude' }]);

    const response = await TestBed.inject(ModelIpcService).discoverModels();

    expect(response).toEqual({
      success: true,
      data: [{ id: 'opus', provider: 'claude' }],
    });
  });

  it('wraps raw legacy model verification booleans in an IPC response', async () => {
    api.modelVerify.mockResolvedValueOnce(true);

    const response = await TestBed.inject(ModelIpcService).verifyModel('opus');

    expect(api.modelVerify).toHaveBeenCalledWith({ modelId: 'opus' });
    expect(response).toEqual({ success: true, data: true });
  });

  it('maps unavailable legacy verification to a failed IPC response', async () => {
    api.modelVerify.mockResolvedValueOnce(false);

    const response = await TestBed.inject(ModelIpcService).verifyModel('missing-model');

    expect(response).toMatchObject({
      success: false,
      data: false,
      error: { message: 'Model is not available.' },
    });
  });
});
