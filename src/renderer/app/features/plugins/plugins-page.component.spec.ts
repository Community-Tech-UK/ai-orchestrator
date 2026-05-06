import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import { PluginsPageComponent } from './plugins-page.component';

describe('PluginsPageComponent runtime plugin package controls', () => {
  const pluginIpc = {
    pluginsGetLoaded: vi.fn(),
    pluginsDiscover: vi.fn(),
    pluginsLoad: vi.fn(),
    pluginsUnload: vi.fn(),
    pluginsInstall: vi.fn(),
    pluginsUninstall: vi.fn(),
    pluginsCreateTemplate: vi.fn(),
    onPluginLoaded: vi.fn(() => () => undefined),
    onPluginUnloaded: vi.fn(() => () => undefined),
    onPluginError: vi.fn(() => () => undefined),
    runtimePluginsList: vi.fn(),
    runtimePluginsValidate: vi.fn(),
    runtimePluginsInstall: vi.fn(),
    runtimePluginsUpdate: vi.fn(),
    runtimePluginsPrune: vi.fn(),
    runtimePluginsUninstall: vi.fn(),
  };

  let fixture: ComponentFixture<PluginsPageComponent>;
  let component: PluginsPageComponent;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginIpc.pluginsGetLoaded.mockResolvedValue({ success: true, data: [] });
    pluginIpc.pluginsDiscover.mockResolvedValue({ success: true, data: [] });
    pluginIpc.runtimePluginsList.mockResolvedValue({ success: true, data: [] });
    pluginIpc.runtimePluginsValidate.mockResolvedValue({
      success: true,
      data: { ok: true, manifest: { name: 'Runtime Plugin', version: '1.0.0' }, warnings: [] },
    });
    pluginIpc.runtimePluginsInstall.mockResolvedValue({
      success: true,
      data: { id: 'runtime-plugin', name: 'Runtime Plugin', version: '1.0.0', status: 'installed' },
    });
    pluginIpc.runtimePluginsUpdate.mockResolvedValue({
      success: true,
      data: { id: 'runtime-plugin', name: 'Runtime Plugin', version: '1.1.0', status: 'installed' },
    });
    pluginIpc.runtimePluginsPrune.mockResolvedValue({ success: true, data: { removed: ['stale-plugin'] } });
    pluginIpc.runtimePluginsUninstall.mockResolvedValue({ success: true });

    TestBed.configureTestingModule({
      imports: [PluginsPageComponent],
      providers: [
        { provide: PluginIpcService, useValue: pluginIpc },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });
    fixture = TestBed.createComponent(PluginsPageComponent);
    component = fixture.componentInstance;
  });

  it('infers runtime package sources and validates them', async () => {
    component.runtimeSourceInput.set('https://example.test/plugin.zip');

    await component.validateRuntimeSource();

    expect(pluginIpc.runtimePluginsValidate).toHaveBeenCalledWith({
      type: 'url',
      value: 'https://example.test/plugin.zip',
    });
    expect(component.runtimeValidation()).toMatchObject({
      ok: true,
      manifest: { name: 'Runtime Plugin' },
    });
  });

  it('installs, updates, prunes, and uninstalls runtime plugin packages', async () => {
    component.runtimeSourceInput.set('/tmp/runtime-plugin.zip');

    await component.installRuntimeSource();
    await component.updateRuntimePlugin('runtime-plugin');
    await component.pruneRuntimePlugins();
    await component.uninstallRuntimePlugin('runtime-plugin');

    expect(pluginIpc.runtimePluginsInstall).toHaveBeenCalledWith({
      type: 'zip',
      value: '/tmp/runtime-plugin.zip',
    });
    expect(pluginIpc.runtimePluginsUpdate).toHaveBeenCalledWith('runtime-plugin', undefined);
    expect(pluginIpc.runtimePluginsPrune).toHaveBeenCalledOnce();
    expect(pluginIpc.runtimePluginsUninstall).toHaveBeenCalledWith('runtime-plugin');
  });
});
