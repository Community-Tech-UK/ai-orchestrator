/**
 * Unit tests for CliHealthSettingsTabComponent.
 *
 * Focus: the tab must keep the title-bar "Update CLIs" pill in sync. The pill's
 * poll service only refreshes on launch and every 6h, so whenever this page
 * recomputes CLI health (open, manual Refresh, after an update) it must nudge
 * the pill — otherwise the badge stays stale "even when everything is healthy".
 *
 * Also covers how a card is badged and titled: a second copy of the *same*
 * version is not a warning the user can act on, and a card must not fall back
 * to the raw CLI id for its title.
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

const GROK_SHIM = '/Users/test/.nvm/versions/node/v24.15.0/bin/grok';

function multiCopyEntry(versions: string[], overrides: Record<string, unknown> = {}): unknown {
  const installs = versions.map((version, index) => ({
    path: index === 0 ? GROK_SHIM : `/copy-${index}/grok`,
    version,
    installed: true,
  }));
  return {
    cli: 'grok',
    installs,
    activePath: installs[0]?.path,
    activeVersion: versions[0],
    updateAvailable: false,
    diagnosis: null,
    updatePlan: { cli: 'grok', displayName: 'Grok Build', supported: true },
    ...overrides,
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

  it('treats an installer-maintained mirror as one install, but still lists it', async () => {
    // grok's npm postinstall writes ~/.grok/bin on every install, so this pair
    // is one installation. It must not badge a warning the user cannot clear,
    // and the copy must stay visible — it is really on disk.
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, version: '1.0.34', installed: true },
            { path: '/Users/test/.grok/bin/grok', version: '1.0.34', installed: true, installerCopy: true },
          ],
        })],
      },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.separateInstalls(entry)).toHaveLength(1);
    expect(component.mirrorCount(entry)).toBe(1);
    expect(component.hasVersionMismatch(entry)).toBe(false);
    expect(component.severity(entry)).toBe('healthy');

    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.shadow-warning')).toBeNull();
    expect(host.querySelector('.duplicate-note')?.textContent).toContain('Installed once');

    component.toggle('grok');
    fixture.detectChanges();
    expect(host.querySelectorAll('.install-list li')).toHaveLength(2);
    expect(host.querySelector('.tag-duplicate')?.textContent).toContain('installer copy');
    expect(host.querySelector('.tag-stale')).toBeNull();
  });

  it('does not badge same-version duplicate copies as a warning', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: { entries: [multiCopyEntry(['1.0.34', '1.0.34'])] },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.hasVersionMismatch(entry)).toBe(false);
    expect(component.severity(entry)).toBe('healthy');

    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.shadow-warning')).toBeNull();
    expect(host.querySelector('.duplicate-note')?.textContent?.trim())
      .toBe('2 copies on PATH, all reporting v1.0.34. Nothing to do — the first one is used.');
    expect(host.querySelector('.cli-name')?.textContent).toContain('Grok Build');

    component.toggle('grok');
    fixture.detectChanges();
    expect(host.querySelector('.tag-stale')).toBeNull();
    expect(host.querySelector('.tag-duplicate')?.textContent).toContain('duplicate');
  });

  it('still badges a version mismatch between copies as a warning', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: { entries: [multiCopyEntry(['1.0.34', '1.0.30'])] },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.hasVersionMismatch(entry)).toBe(true);
    expect(component.severity(entry)).toBe('warning');

    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.duplicate-note')).toBeNull();
    const banner = host.querySelector('.shadow-warning')?.textContent ?? '';
    expect(banner).toContain('1 other copy found on PATH');
    // Must not prescribe deletion: for a CLI whose installer keeps a second
    // copy, the recommendation says to reinstall instead.
    expect(banner).not.toContain('stale or redundant');
    expect(banner).toContain('recommendation');

    component.toggle('grok');
    fixture.detectChanges();
    expect(host.querySelector('.tag-duplicate')).toBeNull();
    expect(host.querySelector('.tag-stale')?.textContent).toContain('shadow');
  });

  it('says nothing was readable rather than claiming the copies agree', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, installed: true },
            { path: '/usr/local/bin/grok', installed: true },
          ],
        })],
      },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.versionAgreement(entry)).toBe('unreadable');
    expect(component.copiesNote(entry))
      .toBe('2 copies on PATH, none of which reported a version. Nothing looks wrong — the first copy is used.');
  });

  it('does not flash a version mismatch when a copy version could not be read', async () => {
    // A failed --version probe leaves the row installed with no version.
    // Unknown is not different: claiming a mismatch made a transient probe
    // failure look like a real conflict until the next scan.
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, version: '1.0.34', installed: true },
            { path: '/usr/local/bin/grok', installed: true, error: 'Timeout checking CLI' },
          ],
        })],
      },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.hasVersionMismatch(entry)).toBe(false);
    expect(component.severity(entry)).toBe('healthy');
    // …and the note must not claim they all report the same version.
    expect(component.versionAgreement(entry)).toBe('partial');
    expect(component.copiesNote(entry)).toBe(
      '2 copies on PATH. Every version that could be read is v1.0.34; the rest did'
      + ' not report one. Nothing looks wrong — the first copy is used.',
    );
  });

  it('counts installer copies in the conflict banner and tags rows by version', async () => {
    // npm 1.0.34 + a stale Homebrew 1.0.30 + the installer's own 1.0.34 copy.
    // The banner must account for both other rows the details list shows, and
    // only the row that actually differs from the active version is "shadow".
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, version: '1.0.34', installed: true },
            { path: '/opt/homebrew/bin/grok', version: '1.0.30', installed: true },
            { path: '/Users/test/.grok/bin/grok', version: '1.0.34', installed: true, installerCopy: true },
          ],
        })],
      },
    });
    await component.refresh();

    const entry = component.entries()[0]!;
    expect(component.hasVersionMismatch(entry)).toBe(true);
    expect(component.otherCopyCount(entry)).toBe(2);

    component.toggle('grok');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.shadow-warning')?.textContent)
      .toContain('2 other copies found on PATH');
    expect(host.querySelectorAll('.install-list li')).toHaveLength(3);
    // One stale copy, one installer copy — and no bare "duplicate" tag, since
    // the only same-version extra row is the installer's own.
    expect(host.querySelectorAll('.tag-stale')).toHaveLength(1);
    expect(host.querySelector('.tag-stale')?.textContent).toContain('shadow');
    expect(host.querySelectorAll('.tag-duplicate')).toHaveLength(1);
    expect(host.querySelector('.tag-duplicate')?.textContent).toContain('installer copy');
  });

  it('tags a copy with no readable version as unknown, not as a duplicate', async () => {
    // Unknown is not the same: the note already declines to claim the copies
    // agree, so the tag must not claim it either.
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, version: '1.0.34', installed: true },
            { path: '/usr/local/bin/grok', installed: true, error: 'Timeout checking CLI' },
          ],
        })],
      },
    });
    await component.refresh();

    component.toggle('grok');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const tags = [...host.querySelectorAll('.install-list .tag')].map((tag) => tag.textContent?.trim());
    expect(tags).toEqual(['active', 'version unknown']);
  });

  it('mentions the installer copy alongside a genuine same-version duplicate', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34'], {
          installs: [
            { path: GROK_SHIM, version: '1.0.34', installed: true },
            { path: '/usr/local/bin/grok', version: '1.0.34', installed: true },
            { path: '/Users/test/.grok/bin/grok', version: '1.0.34', installed: true, installerCopy: true },
          ],
        })],
      },
    });
    await component.refresh();

    fixture.detectChanges();
    const note = (fixture.nativeElement as HTMLElement).querySelector('.duplicate-note')?.textContent;
    // The card must account for all three rows the details list shows.
    expect(note).toContain('2 copies on PATH');
    expect(note).toContain('one more copy');
  });

  it('keeps a failing probe suite as a warning even when copies agree', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: {
        entries: [multiCopyEntry(['1.0.34', '1.0.34'], {
          diagnosis: { provider: 'grok', probes: [], overall: 'degraded', recommendations: [] },
        })],
      },
    });
    await component.refresh();

    expect(component.severity(component.entries()[0]!)).toBe('warning');
  });

  it('titles a card from the update plan name when there is no renderer override', async () => {
    diagnoseAllClis.mockResolvedValue({
      success: true,
      data: { entries: [multiCopyEntry(['1.0.34'])] },
    });
    await component.refresh();

    expect(component.cliDisplayName('grok')).toBe('Grok Build');
    // Renderer overrides still win for the names that carry UI-only wording.
    expect(component.cliDisplayName('gemini')).toBe('Google Gemini (legacy)');
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
