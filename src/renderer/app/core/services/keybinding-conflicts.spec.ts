import { describe, expect, it } from 'vitest';
import type { KeyBinding, KeyModifier } from '../../../../shared/types/keybinding.types';
import {
  normalizeCombo,
  normalizeSequence,
  detectKeybindingConflicts,
  serializeKeybindingCustomizations,
  parseKeybindingCustomizations,
  hasNewConflicts,
} from './keybinding-conflicts';

function binding(id: string, keys: KeyBinding['keys'], context?: KeyBinding['context']): KeyBinding {
  return { id, name: id, description: id, keys, context } as KeyBinding;
}

describe('normalizeCombo / normalizeSequence', () => {
  it('normalizes modifier order and treats cmd as meta, case-insensitive key', () => {
    expect(normalizeCombo({ key: 'P', modifiers: ['shift', 'meta'] })).toBe('shift+meta+p');
    expect(normalizeCombo({ key: 'p', modifiers: ['cmd'] })).toBe('meta+p');
    // Order of modifiers in input does not matter.
    expect(normalizeCombo({ key: 'a', modifiers: ['meta', 'ctrl'] })).toBe(
      normalizeCombo({ key: 'a', modifiers: ['ctrl', 'meta'] }),
    );
  });

  it('joins a leader sequence with spaces', () => {
    expect(normalizeSequence([{ key: 'g', modifiers: [] }, { key: 'd', modifiers: [] }])).toBe('g d');
  });
});

describe('detectKeybindingConflicts', () => {
  it('flags two actions bound to the same key in the same scope', () => {
    const conflicts = detectKeybindingConflicts([
      binding('a', { key: 'k', modifiers: ['meta'] }, 'global'),
      binding('b', { key: 'k', modifiers: ['cmd'] }, 'global'),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: 'meta+k', scope: 'global', actionIds: ['a', 'b'] });
  });

  it('does NOT flag the same key in different scopes', () => {
    expect(
      detectKeybindingConflicts([
        binding('a', { key: 'k', modifiers: [] }, 'global'),
        binding('b', { key: 'k', modifiers: [] }, 'editor' as KeyBinding['context']),
      ]),
    ).toHaveLength(0);
  });

  it('flags a leader-prefix conflict (one sequence is a strict prefix of another)', () => {
    const conflicts = detectKeybindingConflicts([
      binding('short', { key: 'g', modifiers: [] }, 'global'),
      binding('long', [{ key: 'g', modifiers: [] }, { key: 'd', modifiers: [] }], 'global'),
    ]);
    expect(conflicts.some((c) => c.actionIds.includes('short') && c.actionIds.includes('long'))).toBe(true);
  });

  it('returns nothing for a conflict-free set', () => {
    expect(
      detectKeybindingConflicts([
        binding('a', { key: 'j', modifiers: ['meta'] }, 'global'),
        binding('b', { key: 'k', modifiers: ['meta'] }, 'global'),
      ]),
    ).toHaveLength(0);
  });
});

describe('parse / serialize keybinding customizations', () => {
  it('round-trips customizations', () => {
    const customs = [{ id: 'a', keys: { key: 'x', modifiers: ['meta'] as KeyModifier[] } }];
    const json = serializeKeybindingCustomizations(customs);
    expect(parseKeybindingCustomizations(json)).toEqual(customs);
  });

  it('accepts a bare array too', () => {
    const json = JSON.stringify([{ id: 'a', keys: { key: 'x', modifiers: [] } }]);
    expect(parseKeybindingCustomizations(json)).toHaveLength(1);
  });

  it('throws on invalid JSON (no partial application possible)', () => {
    expect(() => parseKeybindingCustomizations('{ not json')).toThrow();
  });

  it('throws on a schema mismatch', () => {
    expect(() => parseKeybindingCustomizations(JSON.stringify([{ id: 'a' }]))).toThrow();
    expect(() =>
      parseKeybindingCustomizations(JSON.stringify([{ id: 'a', keys: { key: 'x', modifiers: ['bogus'] } }])),
    ).toThrow();
  });
});

describe('hasNewConflicts', () => {
  it('is true only when a conflict key not present before appears', () => {
    const before = [{ key: 'meta+k', scope: 'global', actionIds: ['a', 'b'] }];
    expect(hasNewConflicts(before, before)).toBe(false);
    expect(
      hasNewConflicts(before, [...before, { key: 'meta+j', scope: 'global', actionIds: ['c', 'd'] }]),
    ).toBe(true);
  });
});
