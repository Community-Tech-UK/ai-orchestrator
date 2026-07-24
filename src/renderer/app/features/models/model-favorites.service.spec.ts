import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { ModelFavoritesService } from './model-favorites.service';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';

const STORAGE_KEY = 'compact-model-picker:favorites:v1';

describe('ModelFavoritesService', () => {
  const settingsSignal = signal<AppSettings>({ ...DEFAULT_SETTINGS });
  const initializedSignal = signal(false);
  const setSetting = vi.fn(async () => ({ success: true }));
  const onSettingsChanged = vi.fn(() => () => undefined);

  const settingsStore = {
    settings: settingsSignal.asReadonly(),
    isInitialized: initializedSignal.asReadonly(),
  };
  const settingsIpc = { setSetting, onSettingsChanged };

  beforeEach(() => {
    vi.clearAllMocks();
    settingsSignal.set({ ...DEFAULT_SETTINGS });
    initializedSignal.set(false);
    window.localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        ModelFavoritesService,
        { provide: SettingsStore, useValue: settingsStore },
        { provide: SettingsIpcService, useValue: settingsIpc },
      ],
    });
  });

  it('writeFavorites mirrors an ordered list into the setting', () => {
    const svc = TestBed.inject(ModelFavoritesService);
    svc.writeFavorites(['claude:opus[1m]', 'codex:gpt-5.6-sol']);
    expect(setSetting).toHaveBeenCalledWith('modelPickerFavorites', [
      'claude:opus[1m]',
      'codex:gpt-5.6-sol',
    ]);
    expect(svc.favorites()).toEqual(['claude:opus[1m]', 'codex:gpt-5.6-sol']);
  });

  it('migrates a saved localStorage list into the setting once, only after init', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['claude:sonnet-5', 'codex:gpt-5.6-sol']),
    );
    const svc = TestBed.inject(ModelFavoritesService);
    TestBed.tick(); // effect runs with initialized=false → no migration yet
    expect(setSetting).not.toHaveBeenCalled();

    initializedSignal.set(true);
    TestBed.tick(); // real settings loaded → migration fires exactly once
    expect(setSetting).toHaveBeenCalledExactlyOnceWith('modelPickerFavorites', [
      'claude:sonnet-5',
      'codex:gpt-5.6-sol',
    ]);
    expect(svc.favorites()).toEqual(['claude:sonnet-5', 'codex:gpt-5.6-sol']);

    // A later settings reload must not re-trigger the migration.
    settingsSignal.set({
      ...DEFAULT_SETTINGS,
      modelPickerFavorites: ['claude:sonnet-5', 'codex:gpt-5.6-sol'],
    });
    TestBed.tick();
    expect(setSetting).toHaveBeenCalledTimes(1);
  });

  it('does not migrate when the setting is already populated', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['claude:sonnet-5']));
    settingsSignal.set({ ...DEFAULT_SETTINGS, modelPickerFavorites: ['claude:opus[1m]'] });
    const svc = TestBed.inject(ModelFavoritesService);
    initializedSignal.set(true);
    TestBed.tick();
    expect(setSetting).not.toHaveBeenCalled();
    expect(svc.favorites()).toEqual(['claude:opus[1m]']);
  });

  it('does not migrate (and stays empty) when there is no saved localStorage list', () => {
    // An uncustomised install has no saved list; nothing — including
    // DEFAULT_FAVORITE_MODEL_KEYS — is ever copied up.
    const svc = TestBed.inject(ModelFavoritesService);
    initializedSignal.set(true);
    TestBed.tick();
    expect(setSetting).not.toHaveBeenCalled();
    expect(svc.favorites()).toEqual([]);
  });

  it('syncs the signal from later setting reloads', () => {
    const svc = TestBed.inject(ModelFavoritesService);
    initializedSignal.set(true);
    TestBed.tick();
    settingsSignal.set({ ...DEFAULT_SETTINGS, modelPickerFavorites: ['codex:gpt-5.6-sol'] });
    TestBed.tick();
    expect(svc.favorites()).toEqual(['codex:gpt-5.6-sol']);
  });
});
