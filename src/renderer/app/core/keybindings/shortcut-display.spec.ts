import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../../../../shared/types/keybinding.types';
import { ariaKeyShortcut, ariaKeyShortcuts, modKeyLabel } from './shortcut-display';

describe('shortcut display', () => {
  it('uses platform modifiers and uppercase letters', () => {
    expect(ariaKeyShortcut({ key: 'h', modifiers: ['meta'] }, false)).toBe('Control+H');
    expect(ariaKeyShortcut({ key: 's', modifiers: ['alt', 'meta'] }, true)).toBe('Alt+Meta+S');
    expect(ariaKeyShortcut({ key: 'h', modifiers: ['ctrl', 'meta'] }, false)).toBe('Control+H');
    expect(ariaKeyShortcut({ key: 'Enter', modifiers: [] }, false)).toBe('Enter');
    expect(ariaKeyShortcut({ key: 'Escape', modifiers: [] }, true)).toBe('Escape');
    expect(ariaKeyShortcut({ key: ' ', modifiers: [] }, true)).toBe('Space');
  });
  it('lists both send bindings and omits sequences', () => {
    const bindings = DEFAULT_KEYBINDINGS.filter(b => b.action === 'send-message');
    expect(ariaKeyShortcuts(bindings, false)).toBe('Enter Control+Enter');
    expect(ariaKeyShortcuts([{ ...bindings[0], keys: [{ key: 'a', modifiers: [] }] }], false)).toBe('');
  });
  it('labels the platform modifier', () => {
    expect(modKeyLabel(true)).toBe('⌘');
    expect(modKeyLabel(false)).toBe('Ctrl');
  });
});
