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

  it('lists each reason a package cannot be installed separately', async () => {
    pluginIpc.runtimePluginsValidate.mockResolvedValueOnce({
      success: true,
      data: { ok: false, errors: ['name: Required', 'version: Required'], warnings: ['No description.'] },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    component.runtimeSourceInput.set('/tmp/bad-plugin');

    await component.validateRuntimeSource();
    fixture.detectChanges();

    const lines = Array.from(
      fixture.nativeElement.querySelectorAll('.runtime-validation span') as NodeListOf<HTMLElement>,
    ).map((line) => line.textContent?.trim());
    expect(lines).toEqual([
      "This package can't be installed:",
      'name: Required',
      'version: Required',
      'No description.',
    ]);
  });

  it('shows a plain sentence first and keeps the technical message behind Details', async () => {
    pluginIpc.runtimePluginsInstall.mockResolvedValueOnce({
      success: false,
      error: { message: 'Runtime plugin validation failed: ENOENT' },
    });
    // Let ngOnInit's own load finish first; it clears errors when it starts.
    fixture.detectChanges();
    await fixture.whenStable();
    component.runtimeSourceInput.set('/tmp/runtime-plugin.zip');

    await component.installRuntimeSource();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.error-banner') as HTMLElement;
    expect(component.errorMessage()).toBe("Couldn't install that package.");
    expect(banner.querySelector('summary')?.textContent?.trim()).toBe('Details');
    expect(banner.querySelector('details')?.textContent).toContain('Runtime plugin validation failed: ENOENT');
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
    expect(component.runtimeStatusMessage()).toBe('Uninstalled runtime-plugin.');
  });

  it('reports how many packages were removed for not working', async () => {
    await component.pruneRuntimePlugins();
    expect(component.runtimeStatusMessage()).toBe('Removed 1 package.');

    pluginIpc.runtimePluginsPrune.mockResolvedValueOnce({ success: true, data: { removed: [] } });
    await component.pruneRuntimePlugins();
    expect(component.runtimeStatusMessage()).toBe('Every package is working; nothing removed.');
  });

  it('lists installed packages and badges only the ones that need attention', async () => {
    pluginIpc.runtimePluginsList.mockResolvedValue({
      success: true,
      data: [
        { id: 'ok', name: 'Working One', status: 'installed' },
        { id: 'bad', name: 'Broken One', status: 'broken' },
      ],
    });

    await component.refresh();
    fixture.detectChanges();

    const badges = Array.from(
      fixture.nativeElement.querySelectorAll('.plugin-card .status-badge') as NodeListOf<HTMLElement>,
    ).map((badge) => badge.textContent?.trim());
    expect(component.runtimePlugins()).toHaveLength(2);
    expect(badges).toEqual(["Can't load"]);
    expect(component.errorMessage()).toBeNull();
  });

  it('still lists packages when the project trust query fails', async () => {
    selectedInstance.set({ workingDirectory: '/repo' });
    pluginIpc.projectPluginTrustQuery.mockRejectedValue(new Error('No handler registered'));
    pluginIpc.runtimePluginsList.mockResolvedValue({
      success: true,
      data: [{ id: 'rt', name: 'Runtime One', status: 'installed' }],
    });

    await component.refresh();

    expect(component.runtimePlugins()).toHaveLength(1);
    expect(component.errorMessage()).toBe("Couldn't read plugin trust for this project.");
    expect(component.loading()).toBe(false);
  });

  it('reports a failed package list instead of claiming nothing is installed', async () => {
    pluginIpc.runtimePluginsList.mockResolvedValue({ success: false, error: { message: 'boom' } });

    // The first render runs ngOnInit, which loads the page itself.
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.errorMessage()).toBe("Couldn't read the installed packages.");
    expect(component.errorDetail()).toBe('boom');
    expect(fixture.nativeElement.textContent).not.toContain('No packages installed.');
  });

  it('names packages by their display name in status messages', async () => {
    pluginIpc.runtimePluginsList.mockResolvedValue({
      success: true,
      data: [{ id: 'rt', name: 'Runtime One', status: 'installed' }],
    });
    await component.refresh();

    await component.updateRuntimePlugin('rt');
    expect(component.runtimeStatusMessage()).toBe('Updated Runtime One.');

    await component.uninstallRuntimePlugin('rt');
    expect(component.runtimeStatusMessage()).toBe('Uninstalled Runtime One.');
  });

  it('blocks a project plugin folder and explains the result', async () => {
    selectedInstance.set({ workingDirectory: '/repo' });
    await component.refresh();
    pluginIpc.projectPluginTrustQuery.mockResolvedValueOnce({
      success: true,
      data: { decisions: [{ projectRoot: '/repo', trust: 'untrusted', reason: 'Project plugin root is rejected in settings.' }] },
    });

    await component.revokeProjectPluginTrust('/repo');
    fixture.detectChanges();

    expect(pluginIpc.projectPluginTrustRevoke).toHaveBeenCalledWith('/repo');
    expect(fixture.nativeElement.textContent).toContain('Blocked');
    expect(fixture.nativeElement.textContent).toContain('Plugins in this folder are blocked.');
    expect(fixture.nativeElement.textContent).not.toContain('rejected in settings');
  });

  it('surfaces project plugin trust decisions for the selected workspace and can grant trust', async () => {
    selectedInstance.set({ workingDirectory: '/repo' });

    await component.refresh();
    fixture.detectChanges();

    expect(pluginIpc.projectPluginTrustQuery).toHaveBeenCalledWith('/repo');
    expect(fixture.nativeElement.textContent).toContain('Project plugin trust');
    expect(fixture.nativeElement.textContent).toContain('Not decided');
    expect(fixture.nativeElement.textContent).toContain("Plugins in this folder don't run until you trust it.");
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
