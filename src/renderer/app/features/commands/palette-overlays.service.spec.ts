import { SettingsStore } from '../../core/state/settings.store';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { CommandStore } from '../../core/state/command.store';
import { InstanceStore } from '../../core/state/instance.store';
import { PaletteOverlaysService } from './palette-overlays.service';

describe('PaletteOverlaysService', () => {
  const navigate = vi.fn().mockResolvedValue(true);
  let service: PaletteOverlaysService;
  let actions: ActionDispatchService;
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      { provide: SettingsStore, useValue: { isInitialized: () => false } },
      { provide: Router, useValue: { navigate } },
      { provide: CommandStore, useValue: {} },
      { provide: InstanceStore, useValue: { selectedInstance: () => null } },
    ] });
    service = TestBed.inject(PaletteOverlaysService);
    actions = TestBed.inject(ActionDispatchService);
  });
  it('toggles the palette with no session or dashboard and opens help', async () => {
    expect(await actions.dispatch('toggle-command-palette')).toBe(true);
    expect(service.commandPaletteOpen()).toBe(true);
    await actions.dispatch('toggle-command-palette');
    expect(service.commandPaletteOpen()).toBe(false);
    expect(await actions.dispatch('app.open-command-help')).toBe(true);
    expect(service.commandHelpOpen()).toBe(true);
  });
  it('handles the platform palette shortcut with no session or dashboard', () => {
    const isMac = navigator.platform.includes('Mac');
    const event = new KeyboardEvent('keydown', {
      key: 'k', metaKey: isMac, ctrlKey: !isMac,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(service.commandPaletteOpen()).toBe(true);
  });
  it('owns all four global destinations and closes overlays when navigating', async () => {
    for (const [id, path, fragment] of [
      ['toggle-settings', '/settings', undefined], ['app.open-rlm', '/rlm', undefined],
      ['app.open-browser', '/browser', undefined], ['app.open-doctor', '/settings', 'doctor'],
    ]) {
      service.commandPaletteOpen.set(true);
      expect(await actions.dispatch(id!)).toBe(true);
      expect(navigate).toHaveBeenLastCalledWith([path], { fragment });
      expect(service.commandPaletteOpen()).toBe(false);
    }
  });
});
