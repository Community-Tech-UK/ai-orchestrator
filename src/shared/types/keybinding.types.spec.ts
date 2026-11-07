import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
  DEFAULT_KEYBINDINGS,
  matchesKeybindingWhen,
  formatKeyCombo,
} from './keybinding.types';

describe('matchesKeybindingWhen', () => {
  it('allows bindings with no clauses', () => {
    expect(matchesKeybindingWhen(undefined, DEFAULT_KEYBINDING_ELIGIBILITY_STATE)).toBe(true);
    expect(matchesKeybindingWhen([], DEFAULT_KEYBINDING_ELIGIBILITY_STATE)).toBe(true);
  });

  it('matches any satisfied eligibility clause', () => {
    expect(matchesKeybindingWhen(['instance-selected'], {
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      instanceSelected: true,
    })).toBe(true);

    expect(matchesKeybindingWhen(['command-palette-open', 'history-open'], {
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      historyOpen: true,
    })).toBe(true);
  });

  it('rejects bindings when no eligibility clause matches', () => {
    expect(matchesKeybindingWhen(['instance-running'], {
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      instanceRunning: false,
    })).toBe(false);
  });

  it('matches chat-selected clause when chatSelected is true', () => {
    expect(matchesKeybindingWhen(['chat-selected'], {
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      chatSelected: true,
    })).toBe(true);

    expect(matchesKeybindingWhen(['chat-selected'], {
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      chatSelected: false,
    })).toBe(false);
  });
});

it('makes both palette bindings global without a session predicate', () => {
  const bindings = DEFAULT_KEYBINDINGS.filter(binding => binding.action === 'toggle-command-palette');
  expect(bindings).toHaveLength(2);
  for (const binding of bindings) {
    expect(binding.context).toBe('global');
    expect(binding.when).toBeUndefined();
  }
});

it('uses session names in shortcuts without changing their action IDs', () => {
  expect(DEFAULT_KEYBINDINGS.find(b => b.id === 'select-orchestrator')?.name).toBe('Show chats');
  for (const id of ['new-instance', 'close-instance', 'next-instance', 'prev-instance', 'restart-instance']) {
    const binding = DEFAULT_KEYBINDINGS.find(b => b.id === id)!;
    expect(binding.name).toContain('session');
    expect(binding.description).not.toContain('instance');
    expect(binding.action).toBe(id);
  }
});

describe('formatKeyCombo platform labels', () => {
  it('displays meta and cmd as Control off the Mac', () => {
    expect(formatKeyCombo({ key: 'h', modifiers: ['meta'] }, false)).toBe('Ctrl+H');
    expect(formatKeyCombo({ key: 'h', modifiers: ['cmd'] }, false)).toBe('Ctrl+H');
    expect(formatKeyCombo({ key: 'k', modifiers: ['ctrl', 'meta', 'shift'] }, false)).toBe('Ctrl+Shift+K');
  });
  it('preserves Mac symbols', () => {
    expect(formatKeyCombo({ key: 'h', modifiers: ['meta'] }, true)).toBe('⌘H');
  });
});
