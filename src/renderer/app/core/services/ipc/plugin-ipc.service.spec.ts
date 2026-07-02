import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { PluginIpcService } from './plugin-ipc.service';

describe('PluginIpcService runtime plugin package methods', () => {
  const api = {
    runtimePluginsList: vi.fn(),
    runtimePluginsValidate: vi.fn(),
    runtimePluginsInstall: vi.fn(),
    runtimePluginsUpdate: vi.fn(),
    runtimePluginsPrune: vi.fn(),
    runtimePluginsUninstall: vi.fn(),
    projectPluginTrustQuery: vi.fn(),
    projectPluginTrustGrant: vi.fn(),
    projectPluginTrustRevoke: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.runtimePluginsList.mockResolvedValue({ success: true, data: [] });
    api.runtimePluginsValidate.mockResolvedValue({ success: true, data: { ok: true } });
    api.runtimePluginsInstall.mockResolvedValue({ success: true, data: { id: 'plugin-a' } });
    api.runtimePluginsUpdate.mockResolvedValue({ success: true, data: { id: 'plugin-a' } });
    api.runtimePluginsPrune.mockResolvedValue({ success: true, data: { removed: [] } });
    api.runtimePluginsUninstall.mockResolvedValue({ success: true });
    api.projectPluginTrustQuery.mockResolvedValue({ success: true, data: { decisions: [] } });
    api.projectPluginTrustGrant.mockResolvedValue({ success: true, data: { trust: 'trusted' } });
    api.projectPluginTrustRevoke.mockResolvedValue({ success: true, data: { trust: 'untrusted' } });

    TestBed.configureTestingModule({
      providers: [
        PluginIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => api,
            getNgZone: () => ({ run: (fn: () => void) => fn() }),
          },
        },
      ],
    });
  });

  it('delegates runtime plugin list, validate, install, update, prune, and uninstall to preload methods', async () => {
    const service = TestBed.inject(PluginIpcService);
    const source = { type: 'directory' as const, value: '/tmp/plugin-a' };

    await service.runtimePluginsList();
    await service.runtimePluginsValidate(source);
    await service.runtimePluginsInstall(source);
    await service.runtimePluginsUpdate('plugin-a', source);
    await service.runtimePluginsPrune();
    await service.runtimePluginsUninstall('plugin-a');

    expect(api.runtimePluginsList).toHaveBeenCalledOnce();
    expect(api.runtimePluginsValidate).toHaveBeenCalledWith(source);
    expect(api.runtimePluginsInstall).toHaveBeenCalledWith(source);
    expect(api.runtimePluginsUpdate).toHaveBeenCalledWith('plugin-a', source);
    expect(api.runtimePluginsPrune).toHaveBeenCalledOnce();
    expect(api.runtimePluginsUninstall).toHaveBeenCalledWith('plugin-a');
  });

  it('delegates project plugin trust query, grant, and revoke to preload methods', async () => {
    const service = TestBed.inject(PluginIpcService);

    await service.projectPluginTrustQuery('/repo');
    await service.projectPluginTrustGrant('/repo');
    await service.projectPluginTrustRevoke('/repo');

    expect(api.projectPluginTrustQuery).toHaveBeenCalledWith('/repo');
    expect(api.projectPluginTrustGrant).toHaveBeenCalledWith('/repo');
    expect(api.projectPluginTrustRevoke).toHaveBeenCalledWith('/repo');
  });
});
