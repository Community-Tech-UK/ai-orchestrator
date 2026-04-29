import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDINGS,
  type KeybindingAction,
  matchesKeyCombo,
} from '../keybinding.types';

describe('keybinding.types', () => {
  it('includes Wave 2 action literals', () => {
    const actions: KeybindingAction[] = [
      'select-visible-instance-1',
      'select-visible-instance-9',
      'open-session-picker',
      'open-model-picker',
      'open-prompt-history-search',
      'recall-prompt-prev',
      'recall-prompt-next',
    ];

    expect(actions).toHaveLength(7);
  });

  it('registers numeric visible-instance defaults for slots 1 through 9', () => {
    const actions = DEFAULT_KEYBINDINGS
      .filter((binding) => binding.action.startsWith('select-visible-instance-'))
      .map((binding) => binding.action);

    expect(actions).toEqual([
      'select-visible-instance-1',
      'select-visible-instance-2',
      'select-visible-instance-3',
      'select-visible-instance-4',
      'select-visible-instance-5',
      'select-visible-instance-6',
      'select-visible-instance-7',
      'select-visible-instance-8',
      'select-visible-instance-9',
    ]);
  });

  it('uses modifier-bearing defaults for Wave 2 picker shortcuts', () => {
    const session = DEFAULT_KEYBINDINGS.find((binding) => binding.id === 'open-session-picker');
    const model = DEFAULT_KEYBINDINGS.find((binding) => binding.id === 'open-model-picker');
    const search = DEFAULT_KEYBINDINGS.find((binding) => binding.id === 'open-prompt-history-search');

    expect(session?.keys).toEqual({ key: 'o', modifiers: ['meta'] });
    expect(model?.keys).toEqual({ key: 'm', modifiers: ['meta', 'shift'] });
    expect(search?.keys).toEqual({ key: 'r', modifiers: ['ctrl'] });
  });

  it('matches Cmd+digit defaults without matching plain digits', () => {
    const binding = DEFAULT_KEYBINDINGS.find((item) => item.id === 'select-visible-instance-1');
    const keys = Array.isArray(binding?.keys) ? binding?.keys[0] : binding?.keys;

    expect(keys).toBeDefined();
    expect(matchesKeyCombo(
      { key: '1', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
      keys!,
    )).toBe(true);
    expect(matchesKeyCombo(
      { key: '1', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
      keys!,
    )).toBe(false);
  });
});
