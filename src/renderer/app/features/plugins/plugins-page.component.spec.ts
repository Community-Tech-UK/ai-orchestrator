import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import { PluginsPageComponent } from './plugins-page.component';
import { InstanceStore } from '../../core/state/instance/instance.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './plugins-page.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plugins-page.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('PluginsPageComponent', () => {
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
    projectPluginTrustQuery: vi.fn(),
    projectPluginTrustGrant: vi.fn(),
    projectPluginTrustRevoke: vi.fn(),
  };
  const selectedInstance = signal<{ workingDirectory: string } | null>(null);

  let fixture: ComponentFixture<PluginsPageComponent>;
  let component: PluginsPageComponent;

  beforeEach(async () => {
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
    pluginIpc.projectPluginTrustQuery.mockResolvedValue({
      success: true,
      data: {
        decisions: [
          {
            projectRoot: '/repo',
            trust: 'ask',
            reason: 'No trust decision recorded for project plugins at this root.',
          },
        ],
      },
    });
    pluginIpc.projectPluginTrustGrant.mockResolvedValue({
      success: true,
      data: { projectRoot: '/repo', trust: 'trusted', reason: 'Project plugin root is trusted in settings.' },
    });
    pluginIpc.projectPluginTrustRevoke.mockResolvedValue({
      success: true,
      data: { projectRoot: '/repo', trust: 'untrusted', reason: 'Project plugin root is rejected in settings.' },
    });
    selectedInstance.set(null);

    await TestBed.configureTestingModule({
      imports: [PluginsPageComponent],
      providers: [
        { provide: PluginIpcService, useValue: pluginIpc },
        { provide: InstanceStore, useValue: { selectedInstance } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
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

  it('populates loaded, available, and runtime lists on refresh', async () => {
    pluginIpc.pluginsGetLoaded.mockResolvedValue({
      success: true,
      data: [
        { id: 'p1', name: 'Plugin One', status: 'loaded' },
        { id: 'p2', name: 'Plugin Two', status: 'unloaded' },
      ],
    });
    pluginIpc.pluginsDiscover.mockResolvedValue({
      success: true,
      data: [{ id: 'p1', name: 'Plugin One', status: 'unloaded' }],
    });
    pluginIpc.runtimePluginsList.mockResolvedValue({
      success: true,
      data: [{ id: 'rt', name: 'Runtime One', status: 'installed' }],
    });

    await component.refresh();

    expect(component.loadedPlugins()).toHaveLength(2);
    expect(component.availablePlugins()).toHaveLength(1);
    expect(component.runtimePlugins()).toHaveLength(1);
    expect(component.loadedCount()).toBe(1);
    expect(component.installedCount()).toBe(2);
    expect(component.runtimePackageCount()).toBe(1);
    expect(component.errorMessage()).toBeNull();
  });

  it('still loads runtime packages when the provider plugin list fails', async () => {
    // Regression: a rejecting pluginsGetLoaded() must not abort the whole
    // refresh and blank the runtime package list.
    pluginIpc.pluginsGetLoaded.mockRejectedValue(new Error('No handler registered'));
    pluginIpc.runtimePluginsList.mockResolvedValue({
      success: true,
      data: [{ id: 'rt', name: 'Runtime One', status: 'installed' }],
    });

    await component.refresh();

    expect(component.runtimePlugins()).toHaveLength(1);
    expect(component.runtimePackageCount()).toBe(1);
    expect(component.errorMessage()).toBeTruthy();
    expect(component.loading()).toBe(false);
  });

  it('surfaces project plugin trust decisions for the selected workspace and can grant trust', async () => {
    selectedInstance.set({ workingDirectory: '/repo' });

    await component.refresh();
    fixture.detectChanges();

    expect(pluginIpc.projectPluginTrustQuery).toHaveBeenCalledWith('/repo');
    expect(fixture.nativeElement.textContent).toContain('Project Plugin Trust');
    expect(fixture.nativeElement.textContent).toContain('/repo');
    expect(fixture.nativeElement.textContent).toContain('Grant trust');

    pluginIpc.projectPluginTrustQuery.mockResolvedValueOnce({
      success: true,
      data: {
        decisions: [
          {
            projectRoot: '/repo',
            trust: 'trusted',
            reason: 'Project plugin root is trusted in settings.',
          },
        ],
      },
    });
    await component.grantProjectPluginTrust('/repo');

    expect(pluginIpc.projectPluginTrustGrant).toHaveBeenCalledWith('/repo');
    expect(component.projectPluginTrustDecisions()[0]?.trust).toBe('trusted');
  });
});
