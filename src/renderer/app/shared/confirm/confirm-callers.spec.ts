import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmService } from './confirm.service';
import { SourceControlComponent } from '../../features/source-control/source-control.component';
import { NodeServicePanelComponent } from '../../features/remote-nodes/node-service-panel/node-service-panel.component';
import { CliSettingsPanelComponent } from '../../features/verification/config/cli-settings-panel.component';
import { ArchivePageComponent } from '../../features/archive/archive-page.component';
import { ApiKeyManagerComponent } from '../../features/verification/config/api-key-manager.component';
import { MobileSettingsTabComponent } from '../../features/settings/mobile-settings-tab.component';
import { ProviderAccountsTabComponent } from '../../features/settings/provider-accounts-tab.component';
import { ProviderAccountChipComponent } from '../components/provider-account-chip.component';
import { RecentDirectoriesDropdownComponent } from '../components/recent-directories-dropdown/recent-directories-dropdown.component';
import type { RepoState } from '../../features/source-control/source-control.types';

// Exercise the actual action methods without constructing unrelated editor,
// catalog or IPC subscription graphs. The confirmation service is real.
function receiver<T extends object>(prototype: T, state: object): T {
  return Object.assign(Object.create(prototype) as T, state);
}

describe('migrated confirmation actions', () => {
  const repo = { absolutePath: '/project' } as RepoState;

  it.each([false, true])('gates tracked discard and file and directory Trash on answer %s', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const discardFiles = vi.fn();
    const component = receiver(SourceControlComponent.prototype, { confirmService, store: { discardFiles } });
    const tracked = component.onDiscardFile(repo, 'edited.ts');
    expect(discardFiles).not.toHaveBeenCalled();
    expect(confirmService.pending()?.danger).toBe(true);
    confirmService.resolve(answer);
    await tracked;
    expect(discardFiles).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (answer) expect(discardFiles).toHaveBeenCalledWith('/project', ['edited.ts']);
    for (const filePath of ['new-folder/', 'new-file.ts']) {
      discardFiles.mockClear();
      const pending = component.onDiscardUntracked(repo, filePath);
      expect(discardFiles).not.toHaveBeenCalled();
      expect(confirmService.pending()).toMatchObject({ confirmLabel: 'Move to Trash', danger: false });
      expect(confirmService.pending()?.message).toContain(filePath);
      confirmService.resolve(answer);
      await pending;
      expect(confirmService.pending()).toBeNull();
      expect(discardFiles).toHaveBeenCalledTimes(answer ? 1 : 0);
      if (answer) expect(discardFiles).toHaveBeenCalledWith('/project', [filePath]);
    }
  });

  it.each([false, true])('gates worker uninstall on answer %s and retains the prompted node', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const uninstallService = vi.fn();
    let node = 'worker-a';
    const component = receiver(NodeServicePanelComponent.prototype, {
      confirmService, nodeId: () => node, store: { uninstallService },
    });
    const pending = component.uninstall();
    expect(uninstallService).not.toHaveBeenCalled();
    node = 'worker-b';
    confirmService.resolve(answer);
    await pending;
    expect(uninstallService).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (answer) expect(uninstallService).toHaveBeenCalledWith('worker-a');
  });

  it.each([false, true])('gates verification clear and settings reset on answer %s', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const clearHistory = vi.fn();
    const loadCliSettings = vi.fn();
    const component = receiver(CliSettingsPanelComponent.prototype, {
      confirmService, store: { clearHistory }, loadCliSettings, maxConcurrent: 9,
    });
    const clear = component.clearAllData();
    expect(clearHistory).not.toHaveBeenCalled();
    confirmService.resolve(answer);
    await clear;
    expect(clearHistory).toHaveBeenCalledTimes(answer ? 1 : 0);
    const reset = component.resetToDefaults();
    expect(component.maxConcurrent).toBe(9);
    confirmService.resolve(answer);
    await reset;
    expect(component.maxConcurrent).toBe(answer ? 4 : 9);
    expect(loadCliSettings).toHaveBeenCalledTimes(answer ? 1 : 0);
  });

  it.each([false, true])('gates archive and API key deletion on answer %s', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const archiveDelete = vi.fn(async () => ({ success: true }));
    const component = receiver(ArchivePageComponent.prototype, {
      confirmService, archiveIpc: { archiveDelete }, working: signal(false), errorMessage: signal(null),
      infoMessage: signal(null), selectedEntry: signal(null), loadArchives: vi.fn(async () => undefined),
    });
    const pending = component.deleteEntry(new Event('click'), { id: 'archive-a', sessionId: 'session-a', createdAt: 1, tags: [] });
    expect(archiveDelete).not.toHaveBeenCalled();
    confirmService.resolve(answer);
    await pending;
    expect(archiveDelete).toHaveBeenCalledTimes(answer ? 1 : 0);

    const apiKeys = signal([{ id: 'key-a' }]);
    const manager = receiver(ApiKeyManagerComponent.prototype, { confirmService, apiKeys });
    const deletion = manager.deleteKey('key-a');
    expect(apiKeys()).toHaveLength(1);
    confirmService.resolve(answer);
    await deletion;
    expect(apiKeys()).toHaveLength(answer ? 0 : 1);
  });

  it.each([false, true])('gates device revoke, account removal, and recent directory clear on answer %s', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const revokeDevice = vi.fn(async () => undefined);
    const mobile = receiver(MobileSettingsTabComponent.prototype, {
      confirmService, ipc: { revokeDevice, listDevices: vi.fn(async () => []) }, error: signal(null), devices: signal([]),
    });
    const revoke = (mobile as unknown as { revoke(device: { deviceId: string; label: string }): Promise<void> })
      .revoke({ deviceId: 'phone-a', label: 'Phone' });
    expect(revokeDevice).not.toHaveBeenCalled();
    confirmService.resolve(answer);
    await revoke;
    expect(revokeDevice).toHaveBeenCalledTimes(answer ? 1 : 0);

    const remove = vi.fn(async () => ({ success: true }));
    const accounts = receiver(ProviderAccountsTabComponent.prototype, {
      confirmService, ipc: { remove }, mutate: (action: () => Promise<unknown>) => action(),
    });
    const removal = accounts.remove({ id: 'account-a', provider: 'claude', label: 'Work' } as Parameters<typeof accounts.remove>[0]);
    expect(remove).not.toHaveBeenCalled();
    confirmService.resolve(answer);
    await removal;
    expect(remove).toHaveBeenCalledTimes(answer ? 1 : 0);

    const clearAll = vi.fn(async () => undefined);
    const recents = receiver(RecentDirectoriesDropdownComponent.prototype, {
      confirmService, recentDirsService: { clearAll }, loadDirectories: vi.fn(),
    });
    const clear = recents.clearRecent();
    expect(clearAll).not.toHaveBeenCalled();
    confirmService.resolve(answer);
    await clear;
    expect(clearAll).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (answer) expect(clearAll).toHaveBeenCalledWith(true);
  });

  it.each([false, true])('gates the account ownership confirmation before turning an account on on answer %s', async (answer) => {
    const confirmService = TestBed.inject(ConfirmService);
    const acknowledgeOwnership = vi.fn(async () => ({ success: true }));
    const update = vi.fn(async () => ({ success: true }));
    const accounts = signal([{ id: 'account-a', label: 'Work', enabled: false }]);
    const chip = receiver(ProviderAccountChipComponent.prototype, {
      confirmService,
      pooled: () => 'claude',
      ownershipOpen: () => true,
      ipc: { acknowledgeOwnership, update },
      errorSignal: signal<string | null>(null),
      accountsSignal: accounts,
      poolsSignal: signal(null),
    });
    const pending = (chip as unknown as { turnOnForSelection(account: { id: string; label: string; enabled: boolean }, stillBound: () => boolean): Promise<boolean> })
      .turnOnForSelection({ id: 'account-a', label: 'Work', enabled: false }, () => true);
    expect(acknowledgeOwnership).not.toHaveBeenCalled();
    expect(confirmService.pending()?.danger).toBe(true);
    confirmService.resolve(answer);
    await expect(pending).resolves.toBe(answer);
    expect(acknowledgeOwnership).toHaveBeenCalledTimes(answer ? 1 : 0);
    expect(update).toHaveBeenCalledTimes(answer ? 1 : 0);
    if (answer) expect(accounts()[0]?.enabled).toBe(true);
  });
});
