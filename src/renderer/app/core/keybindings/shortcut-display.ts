import type { KeyBinding, KeyCombo, KeyModifier } from '../../../../shared/types/keybinding.types';

/** ARIA uses full modifier names, independent of the visible shortcut chip. */
export function ariaKeyShortcut(combo: KeyCombo, isMac: boolean): string {
  const names: Record<KeyModifier, string> = {
    ctrl: 'Control', alt: 'Alt', shift: 'Shift',
    meta: isMac ? 'Meta' : 'Control', cmd: isMac ? 'Meta' : 'Control',
  };
  const modifiers = [...new Set(combo.modifiers.map(modifier => names[modifier]))];
  const key = combo.key === ' ' ? 'Space' : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  return [...modifiers, key].join('+');
}

/** Leader sequences have no representation in aria-keyshortcuts. */
export function ariaKeyShortcuts(bindings: readonly KeyBinding[], isMac: boolean): string {
  return [...new Set(bindings.flatMap(binding =>
    Array.isArray(binding.keys) ? [] : [ariaKeyShortcut(binding.keys, isMac)],
  ))].join(' ');
}

export function modKeyLabel(isMac: boolean): '⌘' | 'Ctrl' {
  return isMac ? '⌘' : 'Ctrl';
}
