/**
 * Unit tests for CliHealthSettingsTabComponent.
 *
 * Focus: the tab must keep the title-bar "Update CLIs" pill in sync. The pill's
 * poll service only refreshes on launch and every 6h, so whenever this page
 * recomputes CLI health (open, manual Refresh, after an update) it must nudge
 * the pill — otherwise the badge stays stale "even when everything is healthy".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal } from '@angular/core';
import { CliHealthSettingsTabComponent } from './cli-health-settings-tab.component';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(
  resolve(specDirectory, './cli-health-settings-tab.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('cli-health-settings-tab.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function okEntry(cli: string, supported = true): unknown {
  return {
    cli,
    installs: [{ path: `/usr/local/bin/${cli}`, version: '1.0.0', installed: true }],
    activePath: `/usr/local/bin/${cli}`,
    activeVersion: '1.0.0',
    updateAvailable: false,
    diagnosis: null,
    updatePlan: { cli, displayName: cli, supported },
  };
}

describe('CliHealthSettingsTabComponent', () => {
  const diagnoseAllClis = vi.fn();
  const updateCli = vi.fn();
  const updateAllClis = vi.fn();
  const pillRefresh = vi.fn(async () => { /* noop */ });

  const setSetting = vi.fn(async () => { /* noop */ });
  const settingsSignal = signal({ ...DEFAULT_SETTINGS });

  const ipc = { diagnoseAllClis, updateCli, updateAllClis };
  const cliUpdates = { refresh: pillRefresh };
  const settingsStore = { settings: settingsSignal.asReadonly(), set: setSetting };

  let fixture: ComponentFixture<CliHealthSettingsTabComponent>;
  let component: CliHealthSettingsTabComponent;

  beforeEach(async () => {
    vi.clearAllMocks();
    settingsSignal.set({ ...DEFAULT_SETTINGS });
    diagnoseAllClis.mockResolvedValue({ success: true, data: { entries: [] } });

    await TestBed.configureTestingModule({
      imports: [CliHealthSettingsTabComponent],
      providers: [
        { provide: ProviderIpcService, useValue: ipc },
        { provide: CliUpdatePillStore, useValue: cliUpdates },
        { provide: SettingsStore, useValue: settingsStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CliHealthSettingsTabComponent);
    component = fixture.componentInstance;
  });

  it('re-syncs the title-bar pill after a successful diagnosis', async () => {
    await component.refresh();

    expect(diagnoseAllClis).toHaveBeenCalled();
    expect(pillRefresh).toHaveBeenCalled();
  });

  it('does NOT re-sync the pill when the diagnosis fails', async () => {
    diagnoseAllClis.mockResolvedValueOnce({
      success: false,
      error: { message: 'boom' },
    });

    await component.refresh();

    expect(component.error()).toBe('boom');
    expect(pillRefresh).not.toHaveBeenCalled();
  });

  it('re-syncs the pill after updating a single CLI', async () => {
    updateCli.mockResolvedValue({
      success: true,
      data: { cli: 'claude', displayName: 'Claude Code', status: 'updated', message: 'ok', durationMs: 1 },
    });

    await component.updateCli('claude');

    expect(updateCli).toHaveBeenCalledWith('claude');
    // updateCli ends with refresh(), which re-syncs the badge to the new version.
    expect(pillRefresh).toHaveBeenCalled();
  });

  it('re-syncs the pill after "Update all"', async () => {
    // Seed an updatable entry so updateAll() actually runs the updater.
    diagnoseAllClis.mockResolvedValue({ success: true, data: { entries: [okEntry('claude')] } });
    await component.refresh();
    pillRefresh.mockClear();

    updateAllClis.mockResolvedValue({ success: true, data: { results: [] } });
    await component.updateAll();

    expect(updateAllClis).toHaveBeenCalled();
    expect(pillRefresh).toHaveBeenCalled();
  });

  it('does not run the updater (or re-sync) when nothing is updatable', async () => {
    diagnoseAllClis.mockResolvedValue({ success: true, data: { entries: [okEntry('ollama', false)] } });
    await component.refresh();
    pillRefresh.mockClear();

    await component.updateAll();

    expect(updateAllClis).not.toHaveBeenCalled();
    expect(pillRefresh).not.toHaveBeenCalled();
  });

  it('reflects the persisted cliUpdatePolicy in the segmented control', () => {
    expect(component.updatePolicy()).toBe('notify');
    settingsSignal.set({ ...DEFAULT_SETTINGS, cliUpdatePolicy: 'auto' });
    expect(component.updatePolicy()).toBe('auto');
  });

  it('persists a new policy when the control changes', () => {
    component.onPolicyChange('auto');
    expect(setSetting).toHaveBeenCalledWith('cliUpdatePolicy', 'auto');
  });
});
