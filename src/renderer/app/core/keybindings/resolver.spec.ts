import { describe, expect, it } from 'vitest';
import type { KeyBinding, KeybindingEligibilityState } from '../../../../shared/types/keybinding.types';
import { DEFAULT_KEYBINDING_ELIGIBILITY_STATE } from '../../../../shared/types/keybinding.types';
import { eligibleBindings, orderByContextSpecificity } from './resolver';

function binding(overrides: Partial<KeyBinding> & Pick<KeyBinding, 'id' | 'keys'>): KeyBinding {
  return {
    name: overrides.id,
    description: overrides.id,
    action: overrides.id,
    context: 'global',
    ...overrides,
  };
}

const state: KeybindingEligibilityState = { ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE };

describe('orderByContextSpecificity — most-specific-context-wins', () => {
  it('puts a binding scoped to the active context ahead of a global binding sharing its key', () => {
    const global = binding({ id: 'global-escape', keys: { key: 'Escape', modifiers: [] }, context: 'global' });
    const overlay = binding({ id: 'overlay-escape', keys: { key: 'Escape', modifiers: [] }, context: 'overlay' });

    // Deliberately list the global entry FIRST — array order must not decide the winner.
    const ordered = orderByContextSpecificity([global, overlay], 'overlay');

    expect(ordered[0].id).toBe('overlay-escape');
    expect(ordered[1].id).toBe('global-escape');
  });

  it('drops bindings scoped to a different, inactive non-global context', () => {
    const ordered = orderByContextSpecificity(
      [
        binding({ id: 'input-only', keys: { key: 'x', modifiers: [] }, context: 'input' }),
        binding({ id: 'overlay-only', keys: { key: 'y', modifiers: [] }, context: 'overlay' }),
      ],
      'overlay',
    );
    expect(ordered.map((b) => b.id)).toEqual(['overlay-only']);
  });

  it('keeps relative order stable within each group', () => {
    const a = binding({ id: 'a', keys: { key: 'a', modifiers: [] }, context: 'overlay' });
    const b = binding({ id: 'b', keys: { key: 'b', modifiers: [] }, context: 'overlay' });
    const ordered = orderByContextSpecificity([a, b], 'overlay');
    expect(ordered.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('eligibleBindings', () => {
  it('filters out bindings whose `when` clause is not satisfied', () => {
    const eligible = binding({ id: 'eligible', keys: { key: 'a', modifiers: [] }, when: undefined });
    const blocked = binding({
      id: 'blocked',
      keys: { key: 'b', modifiers: [] },
      when: ['instance-selected'],
    });
    const result = eligibleBindings([eligible, blocked], 'global', state);
    expect(result.map((b) => b.id)).toEqual(['eligible']);
  });

  it('resolves the overlay-scoped binding over a same-key global one, respecting when-clauses', () => {
    const globalCancel = binding({
      id: 'cancel-operation',
      keys: { key: 'Escape', modifiers: [] },
      context: 'global',
      when: ['command-palette-open'],
    });
    const overlayClose = binding({ id: 'overlay.close', keys: { key: 'Escape', modifiers: [] }, context: 'overlay' });

    const result = eligibleBindings(
      [globalCancel, overlayClose],
      'overlay',
      { ...state, commandPaletteOpen: true },
    );
    expect(result[0].id).toBe('overlay.close');
  });
});
