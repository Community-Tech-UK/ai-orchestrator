import { describe, expect, it } from 'vitest';
import type { KeyBinding } from '../../../../shared/types/keybinding.types';
import { DEFAULT_KEYBINDINGS } from '../../../../shared/types/keybinding.types';
import {
  describeFirstViolation,
  detectCrossContextConflicts,
  detectReservedKeyViolations,
  validateKeybindingRegistry,
} from './validate';

function binding(overrides: Partial<KeyBinding> & Pick<KeyBinding, 'id' | 'keys'>): KeyBinding {
  return {
    name: overrides.id,
    description: overrides.id,
    action: overrides.id,
    context: 'global',
    ...overrides,
  };
}

describe('validateKeybindingRegistry — shipped registry (the "cannot silently steal" guarantee)', () => {
  it('is safe on both platforms: zero same-scope, cross-context, and reserved-key violations', () => {
    for (const platform of ['mac', 'other'] as const) {
      const result = validateKeybindingRegistry(DEFAULT_KEYBINDINGS, platform);
      expect(result.conflicts, `platform=${platform} same-scope conflicts`).toEqual([]);
      expect(result.crossContextConflicts, `platform=${platform} cross-context conflicts`).toEqual([]);
      expect(result.reservedViolations, `platform=${platform} reserved violations`).toEqual([]);
      expect(result.isSafe).toBe(true);
    }
  });
});

describe('detectCrossContextConflicts — global bindings are always active', () => {
  it('flags a global binding sharing a key with a differently-scoped binding', () => {
    const conflicts = detectCrossContextConflicts([
      binding({ id: 'global-escape', keys: { key: 'Escape', modifiers: [] }, context: 'global' }),
      binding({ id: 'overlay-escape', keys: { key: 'Escape', modifiers: [] }, context: 'overlay' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect([...conflicts[0].actionIds].sort()).toEqual(['global-escape', 'overlay-escape']);
    expect(conflicts[0].scope).toBe('global×overlay');
  });

  it('does not flag two non-global bindings in different contexts (same-scope check already covers same-context)', () => {
    expect(
      detectCrossContextConflicts([
        binding({ id: 'a', keys: { key: 'g', modifiers: [] }, context: 'input' }),
        binding({ id: 'b', keys: { key: 'g', modifiers: [] }, context: 'overlay' }),
      ]),
    ).toEqual([]);
  });

  it('does not flag bindings with distinct key combos', () => {
    expect(
      detectCrossContextConflicts([
        binding({ id: 'a', keys: { key: 'j', modifiers: ['meta'] }, context: 'global' }),
        binding({ id: 'b', keys: { key: 'k', modifiers: ['meta'] }, context: 'overlay' }),
      ]),
    ).toEqual([]);
  });
});

describe('detectReservedKeyViolations', () => {
  it('flags Cmd+Q on mac but not on other platforms', () => {
    const bindings = [binding({ id: 'quit-app', keys: { key: 'q', modifiers: ['meta'] } })];
    expect(detectReservedKeyViolations(bindings, 'mac')).toHaveLength(1);
    expect(detectReservedKeyViolations(bindings, 'other')).toHaveLength(0);
  });

  it('does not flag combos AIO already deliberately uses (Cmd+W, Cmd+H, Cmd+,)', () => {
    const bindings = [
      binding({ id: 'close-instance', keys: { key: 'w', modifiers: ['meta'] } }),
      binding({ id: 'toggle-history', keys: { key: 'h', modifiers: ['meta'] } }),
      binding({ id: 'toggle-settings', keys: { key: ',', modifiers: ['meta'] } }),
    ];
    expect(detectReservedKeyViolations(bindings, 'mac')).toEqual([]);
  });
});

describe('describeFirstViolation', () => {
  it('returns null when safe', () => {
    expect(describeFirstViolation(validateKeybindingRegistry(DEFAULT_KEYBINDINGS, 'mac'))).toBeNull();
  });

  it('prioritizes reserved-key violations, then cross-context, then same-scope', () => {
    const reservedOnly = validateKeybindingRegistry(
      [binding({ id: 'quit-app', keys: { key: 'q', modifiers: ['meta'] } })],
      'mac',
    );
    expect(describeFirstViolation(reservedOnly)).toMatch(/reserved/);
  });
});
