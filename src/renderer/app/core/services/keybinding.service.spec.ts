import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { KeybindingService } from './keybinding.service';

describe('KeybindingService — conflicts + import/export (Task 13)', () => {
  let service: KeybindingService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(KeybindingService);
    service.resetAllBindings();
  });

  it('reports no conflicts for the default bindings', () => {
    expect(service.conflicts()).toEqual([]);
  });

  it('surfaces a conflict when a customization collides with another binding', () => {
    // focus-input ('i') and focus-output ('o') both exist in the global scope.
    // Rebind focus-input onto focus-output's key to force a same-key conflict.
    service.customizeBinding('focus-input', { key: 'o', modifiers: [] });
    const conflicts = service.conflicts();
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.actionIds.includes('focus-input') && c.actionIds.includes('focus-output'))).toBe(true);
  });

  it('round-trips customizations through export → import', () => {
    service.customizeBinding('focus-input', { key: 'q', modifiers: ['meta', 'shift', 'alt'] });
    const json = service.exportKeybindings();

    service.resetAllBindings();
    expect(service.getCustomizations()).toEqual([]);

    const result = service.importKeybindings(json);
    expect(result.applied).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(service.getCustomizations()).toEqual([{ id: 'focus-input', keys: { key: 'q', modifiers: ['meta', 'shift', 'alt'] } }]);
  });

  it('throws on invalid JSON and applies nothing', () => {
    expect(() => service.importKeybindings('{ not valid')).toThrow();
    expect(service.getCustomizations()).toEqual([]);
  });

  it('blocks an import that would introduce a NEW conflict (no partial apply)', () => {
    const before = service.getCustomizations();
    const conflicting = JSON.stringify([{ id: 'focus-input', keys: { key: 'o', modifiers: [] } }]);

    const result = service.importKeybindings(conflicting);

    expect(result.applied).toBe(0);
    expect(result.conflicts.length).toBeGreaterThan(0);
    // State was NOT mutated.
    expect(service.getCustomizations()).toEqual(before);
  });
});
