import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { RemoteNodeIpcService } from './remote-node-ipc.service';

describe('RemoteNodeIpcService', () => {
  let api: {
    remoteNodeRepairDiagnose: ReturnType<typeof vi.fn>;
    remoteNodeRepairCommand: ReturnType<typeof vi.fn>;
  };
  let service: RemoteNodeIpcService;

  beforeEach(() => {
    api = {
      remoteNodeRepairDiagnose: vi.fn(),
      remoteNodeRepairCommand: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        RemoteNodeIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => api,
          },
        },
      ],
    });

    service = TestBed.inject(RemoteNodeIpcService);
  });

  it('calls the repair diagnose preload method and returns null on failure', async () => {
    api.remoteNodeRepairDiagnose.mockResolvedValueOnce({
      success: true,
      data: { nodeId: 'node-1', status: 'depaired' },
    });
    await expect(service.diagnoseRepair('node-1')).resolves.toEqual({
      nodeId: 'node-1',
      status: 'depaired',
    });

    api.remoteNodeRepairDiagnose.mockResolvedValueOnce({ success: false });
    await expect(service.diagnoseRepair('node-1')).resolves.toBeNull();
  });

  it('calls the explicit repair command preload method with operator platform confirmation', async () => {
    api.remoteNodeRepairCommand.mockResolvedValueOnce({
      success: true,
      data: { nodeId: 'node-1', command: 'powershell' },
    });

    await expect(service.generateRepairCommand('node-1', {
      platform: 'win32',
      operatorConfirmedPlatform: true,
    })).resolves.toEqual({ nodeId: 'node-1', command: 'powershell' });

    expect(api.remoteNodeRepairCommand).toHaveBeenCalledWith('node-1', {
      platform: 'win32',
      operatorConfirmedPlatform: true,
    });
  });
});
