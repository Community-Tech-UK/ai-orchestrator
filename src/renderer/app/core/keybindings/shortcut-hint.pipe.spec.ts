import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { KeybindingService } from '../services/keybinding.service';
import { ShortcutHintPipe } from './shortcut-hint.pipe';

describe('ShortcutHintPipe', () => {
  let pipe: ShortcutHintPipe;
  let service: KeybindingService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(KeybindingService);
    service.resetAllBindings();
    pipe = TestBed.runInInjectionContext(() => new ShortcutHintPipe());
  });

  it('returns the empty string for a missing action id', () => {
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform('')).toBe('');
  });

  it('formats the live binding for a known action id', () => {
    expect(pipe.transform('toggle-sidebar')).toBe(service.formatBindingByAction('toggle-sidebar'));
    expect(pipe.transform('toggle-sidebar')).not.toBe('');
  });

  it('reflects a user customization made after the pipe was created (impure)', () => {
    const before = pipe.transform('focus-input');
    service.customizeBinding('focus-input', { key: 'q', modifiers: ['meta', 'alt', 'shift'] });
    const after = pipe.transform('focus-input');
    expect(after).not.toBe(before);
    expect(after).toBe(service.formatBindingByAction('focus-input'));
  });
});
