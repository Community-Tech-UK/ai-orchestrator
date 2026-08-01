/**
 * WS-C9 persistence: KeybindingService loads user overrides from
 * SettingsStore once it initializes, and persists future customizations
 * back to it. See `keybindingCustomizations` in shared/types/settings.types.ts.
 *
 * Mocks `SettingsIpcService` (a leaf dependency used only by SettingsStore)
 * rather than SettingsStore itself, so other root singletons that also
 * depend on the real SettingsStore in this TestBed keep working.
 */
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { KeybindingService } from './keybinding.service';
import { ActionDispatchService } from './action-dispatch.service';
import { SettingsStore } from '../state/settings.store';
import { SettingsIpcService } from '../services/ipc/settings-ipc.service';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import { DEFAULT_KEYBINDING_ELIGIBILITY_STATE } from '../../../../shared/types/keybinding.types';
import { serializeKeybindingCustomizations } from './keybinding-conflicts';

function flushEffects(): void {
  TestBed.tick();
}

// Mirrors the pattern in __tests__/keybinding.service.spec.ts: stub
// ActionDispatchService directly so instantiating KeybindingService doesn't
// pull in CommandStore/InstanceStore (and, transitively, the full IPC
// facade graph) — this spec is only exercising the settings persistence
// wiring, not action dispatch.
const fakeActionDispatch = {
  getState: vi.fn(() => ({ ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE })),
  dispatch: vi.fn(async () => true),
};

function configureModule(storedKeybindingCustomizations: string) {
  const setSetting = vi.fn().mockResolvedValue({ success: true });
  TestBed.configureTestingModule({
    providers: [
      { provide: ActionDispatchService, useValue: fakeActionDispatch },
      {
        provide: SettingsIpcService,
        useValue: {
          updateSettings: vi.fn().mockResolvedValue({ success: true }),
          setSetting,
          getSettings: vi.fn().mockResolvedValue({
            success: true,
            data: { ...DEFAULT_SETTINGS, keybindingCustomizations: storedKeybindingCustomizations },
          }),
          onSettingsChanged: vi.fn(() => () => undefined),
        },
      },
    ],
  });
  return { setSetting };
}

describe('KeybindingService settings persistence (WS-C9)', () => {
  let service: KeybindingService;
  let settingsStore: SettingsStore;

  it('does nothing until the settings store finishes initializing', () => {
    configureModule('');
    service = TestBed.inject(KeybindingService);
    flushEffects();
    expect(service.getCustomizations()).toEqual([]);
  });

  it('loads a valid stored customization once settings initialize', async () => {
    const raw = serializeKeybindingCustomizations([
      { id: 'focus-input', keys: { key: 'q', modifiers: ['meta', 'alt', 'shift'] } },
    ]);
    configureModule(raw);
    service = TestBed.inject(KeybindingService);
    settingsStore = TestBed.inject(SettingsStore);
    flushEffects();

    await settingsStore.initialize();
    flushEffects();

    expect(service.getCustomizations()).toEqual([
      { id: 'focus-input', keys: { key: 'q', modifiers: ['meta', 'alt', 'shift'] } },
    ]);
  });

  it('ignores a corrupted stored value instead of throwing', async () => {
    configureModule('{ not valid json');
    service = TestBed.inject(KeybindingService);
    settingsStore = TestBed.inject(SettingsStore);
    flushEffects();

    await settingsStore.initialize();
    flushEffects();

    expect(service.getCustomizations()).toEqual([]);
  });

  it('rejects a stored customization that would introduce a NEW conflict', async () => {
    // focus-input ('i') and focus-output ('o') are both global; force a collision.
    const raw = serializeKeybindingCustomizations([{ id: 'focus-input', keys: { key: 'o', modifiers: [] } }]);
    configureModule(raw);
    service = TestBed.inject(KeybindingService);
    settingsStore = TestBed.inject(SettingsStore);
    flushEffects();

    await settingsStore.initialize();
    flushEffects();

    expect(service.getCustomizations()).toEqual([]);
  });

  it('persists a future customization back to the settings store after the initial load', async () => {
    const { setSetting } = configureModule('');
    service = TestBed.inject(KeybindingService);
    settingsStore = TestBed.inject(SettingsStore);
    flushEffects();

    await settingsStore.initialize();
    flushEffects();
    setSetting.mockClear();

    service.customizeBinding('focus-input', { key: 'q', modifiers: ['meta', 'shift'] });
    flushEffects();
    await Promise.resolve();

    expect(setSetting).toHaveBeenCalledWith(
      'keybindingCustomizations',
      serializeKeybindingCustomizations([{ id: 'focus-input', keys: { key: 'q', modifiers: ['meta', 'shift'] } }]),
    );
  });
});
