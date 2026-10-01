import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStateService } from './provider-state.service';
import { SettingsStore } from '../state/settings.store';
import { SettingsIpcService } from './ipc/settings-ipc.service';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import { clearKnownModelCatalogSnapshotForTesting } from '../../../../shared/types/provider.types';
import { INTERACTIVE_LAUNCH_MODE_AVAILABLE } from '../../../../shared/types/instance.types';

describe('ProviderStateService model memory startup', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearKnownModelCatalogSnapshotForTesting();
  });

  it('preserves a remembered strict-provider model before the unified catalog has loaded', () => {
    const settings = signal<AppSettings>({
      ...DEFAULT_SETTINGS,
      defaultCli: 'claude',
      defaultModel: 'claude-local-opus',
      defaultModelByProvider: {
        claude: 'claude-local-opus',
      },
      customModelsByProvider: {},
    });
    const settingsIpc = {
      setSetting: vi.fn(),
      onSettingsChanged: vi.fn(() => () => undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        ProviderStateService,
        { provide: SettingsStore, useValue: { settings } },
        { provide: SettingsIpcService, useValue: settingsIpc },
      ],
    });

    const service = TestBed.inject(ProviderStateService);
    TestBed.tick();

    expect(service.selectedProvider()).toBe('claude');
    expect(service.selectedModel()).toBe('claude-local-opus');
    expect(service.getLastModelForProvider('claude')).toBe('claude-local-opus');
    expect(settingsIpc.setSetting).not.toHaveBeenCalledWith(
      'defaultModelByProvider',
      expect.objectContaining({ claude: 'opus[1m]' }),
    );
  });
});

describe('ProviderStateService launch mode memory', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    window.localStorage.clear();
  });

  it.runIf(!INTERACTIVE_LAUNCH_MODE_AVAILABLE)('ignores a remembered interactive Claude launch mode while the terminal runtime is unavailable', () => {
    window.localStorage.setItem('provider-launch-mode:v1', JSON.stringify({ claude: 'interactive' }));
    TestBed.configureTestingModule({
      providers: [
        ProviderStateService,
        { provide: SettingsStore, useValue: { settings: signal<AppSettings>({ ...DEFAULT_SETTINGS }) } },
        {
          provide: SettingsIpcService,
          useValue: { setSetting: vi.fn(), onSettingsChanged: vi.fn(() => () => undefined) },
        },
      ],
    });

    const service = TestBed.inject(ProviderStateService);

    expect(service.getLaunchModeForProvider('claude')).toBe('orchestrated');
  });
});
