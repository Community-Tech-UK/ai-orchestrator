import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc/electron-ipc.service';
import { DoctorStore } from '../doctor.store';

describe('DoctorStore', () => {
  const api = {
    diagnosticsGetDoctorReport: vi.fn(),
    diagnosticsExportArtifactBundle: vi.fn(),
    diagnosticsRevealBundle: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        DoctorStore,
        {
          provide: ElectronIpcService,
          useValue: { getApi: () => api },
        },
      ],
    });
  });

  it('loads a Doctor report through the diagnostics preload domain', async () => {
    api.diagnosticsGetDoctorReport.mockResolvedValue({
      success: true,
      data: { schemaVersion: 1, sections: [] },
    });
    const store = TestBed.inject(DoctorStore);

    await store.load({ workingDirectory: '/repo' });

    expect(api.diagnosticsGetDoctorReport).toHaveBeenCalledWith({ workingDirectory: '/repo' });
    expect(store.report()).toMatchObject({ schemaVersion: 1 });
    expect(store.error()).toBeNull();
  });

  it('sets the active section', () => {
    const store = TestBed.inject(DoctorStore);

    store.setActiveSection('instructions');

    expect(store.activeSection()).toBe('instructions');
  });

  it('exports and reveals an artifact bundle', async () => {
    api.diagnosticsExportArtifactBundle.mockResolvedValue({
      success: true,
      data: { bundlePath: '/tmp/x.zip', bundleBytes: 1, manifest: { files: [] } },
    });
    api.diagnosticsRevealBundle.mockResolvedValue({ success: true });
    const store = TestBed.inject(DoctorStore);

    await expect(store.exportBundle({ workingDirectory: '/repo' })).resolves.toMatchObject({
      bundlePath: '/tmp/x.zip',
    });
    await expect(store.revealBundle('/tmp/x.zip')).resolves.toBeUndefined();
    expect(api.diagnosticsRevealBundle).toHaveBeenCalledWith({ bundlePath: '/tmp/x.zip' });
  });
});
