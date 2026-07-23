import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import { SettingsIpcService } from '../services/ipc/settings-ipc.service';
import { SettingsStore } from './settings.store';

interface MockMql {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  fireChange(matches: boolean): void;
}

function makeMockMql(initialMatches = false): MockMql {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];
  return {
    matches: initialMatches,
    addEventListener: vi.fn((_event: 'change', listener: (event: MediaQueryListEvent) => void) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_event: 'change', listener: (event: MediaQueryListEvent) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }),
    fireChange(matches: boolean): void {
      this.matches = matches;
      listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
    },
  };
}

describe('SettingsStore system theme listener', () => {
  let mql: MockMql;
  let store: SettingsStore;

  beforeEach(() => {
    mql = makeMockMql();
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => mql),
      configurable: true,
    });
    document.documentElement.removeAttribute('data-theme');

    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsIpcService,
          useValue: {
            updateSettings: vi.fn().mockResolvedValue({ success: true }),
            setSetting: vi.fn().mockResolvedValue({ success: true }),
            getSettings: vi.fn().mockResolvedValue({ success: true, data: DEFAULT_SETTINGS }),
            onSettingsChanged: vi.fn(() => () => undefined),
          },
        },
      ],
    });
    store = TestBed.inject(SettingsStore);
  });

  function flushEffects(): void {
    TestBed.tick();
  }

  it('attaches a change listener when theme switches to system', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('detaches when theme switches to an explicit mode', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'dark' });
    flushEffects();

    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('re-attaches when switching back to system', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'light' });
    flushEffects();
    await store.update({ theme: 'system' });
    flushEffects();

    expect(mql.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('updates data-theme on OS change while system mode is active', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    mql.fireChange(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    mql.fireChange(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores OS changes after switching to an explicit mode', async () => {
    await store.update({ theme: 'system' });
    flushEffects();
    await store.update({ theme: 'light' });
    flushEffects();

    mql.fireChange(true);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('_resetForTesting removes the listener', async () => {
    await store.update({ theme: 'system' });
    flushEffects();

    store._resetForTesting();

    expect(mql.removeEventListener).toHaveBeenCalled();
  });

  it('exposes MCP settings with backup cleanup enabled by default', () => {
    expect(DEFAULT_SETTINGS.mcpCleanupBackupsOnQuit).toBe(true);
    expect(DEFAULT_SETTINGS.mcpDisableProviderBackups).toBe(false);
    expect(DEFAULT_SETTINGS.mcpAllowWorldWritableParent).toBe(false);
    expect(store.mcpSettings().map((setting) => setting.key)).toEqual([
      'graphClientId',
      'graphAuthority',
      'graphScopesJson',
      'graphAgentWritableAccountsJson',
      'mcpCleanupBackupsOnQuit',
      'mcpDisableProviderBackups',
      'mcpAllowWorldWritableParent',
      'computerUseEnabled',
      'computerUseAllowedAppsJson',
      'computerUseDeniedAppsJson',
      'computerUseRequireApprovalForInput',
      'computerUseStoreScreenshotsForEscalations',
    ]);
  });
});

describe('SettingsStore appearance preview', () => {
  let mql: MockMql;
  let store: SettingsStore;
  let ipc: {
    updateSettings: ReturnType<typeof vi.fn>;
    setSetting: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    onSettingsChanged: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mql = makeMockMql();
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => mql),
      configurable: true,
    });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.removeAttribute('data-sidebar-style');
    document.documentElement.style.removeProperty('--output-font-size');

    ipc = {
      updateSettings: vi.fn().mockResolvedValue({ success: true }),
      setSetting: vi.fn().mockResolvedValue({ success: true }),
      getSettings: vi.fn().mockResolvedValue({ success: true, data: DEFAULT_SETTINGS }),
      onSettingsChanged: vi.fn(() => () => undefined),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: SettingsIpcService, useValue: ipc }],
    });
    store = TestBed.inject(SettingsStore);
  });

  function flushEffects(): void {
    TestBed.tick();
  }

  it('previews a theme change on the document without persisting it', () => {
    store.previewAppearance({ theme: 'light' });
    flushEffects();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(store.settings().theme).toBe('dark');
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps system theme preview responsive to OS changes without persisting it', () => {
    store.previewAppearance({ theme: 'system' });
    flushEffects();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    mql.fireChange(true);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(store.settings().theme).toBe('dark');
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('previews a font-size change on the document without persisting it', () => {
    store.previewAppearance({ fontSize: 19 });
    flushEffects();

    expect(document.documentElement.style.getPropertyValue('--output-font-size')).toBe('19px');
    expect(store.settings().fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('previews density and sidebar style changes on the document without persisting them', () => {
    store.previewAppearance({
      displayDensity: 'compact',
      sidebarStyle: 'compact',
    } as Parameters<typeof store.previewAppearance>[0]);
    flushEffects();

    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(document.documentElement.getAttribute('data-sidebar-style')).toBe('compact');
    expect((store.settings() as { displayDensity?: string }).displayDensity).toBe('comfortable');
    expect((store.settings() as { sidebarStyle?: string }).sidebarStyle).toBe('standard');
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('clearAppearancePreview reverts to the saved theme', () => {
    store.previewAppearance({ theme: 'light' });
    flushEffects();
    store.clearAppearancePreview();
    flushEffects();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(store.appearancePreview()).toBeNull();
  });

  it('commitAppearancePreview persists the staged change and clears the preview', async () => {
    store.previewAppearance({
      theme: 'light',
      fontSize: 17,
      displayDensity: 'compact',
      sidebarStyle: 'compact',
    } as Parameters<typeof store.previewAppearance>[0]);
    flushEffects();

    await store.commitAppearancePreview();
    flushEffects();

    expect(ipc.updateSettings).toHaveBeenCalledWith({
      theme: 'light',
      fontSize: 17,
      displayDensity: 'compact',
      sidebarStyle: 'compact',
    });
    expect(store.settings().theme).toBe('light');
    expect(store.settings().fontSize).toBe(17);
    expect((store.settings() as { displayDensity?: string }).displayDensity).toBe('compact');
    expect((store.settings() as { sidebarStyle?: string }).sidebarStyle).toBe('compact');
    expect(store.appearancePreview()).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(document.documentElement.getAttribute('data-sidebar-style')).toBe('compact');
  });

  it('commitAppearancePreview is a no-op when no preview is staged', async () => {
    await store.commitAppearancePreview();
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });
});
