import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStateService } from './provider-state.service';
import { SettingsStore } from '../state/settings.store';
import { SettingsIpcService } from './ipc/settings-ipc.service';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import { clearKnownModelCatalogSnapshotForTesting } from '../../../../shared/types/provider.types';

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
