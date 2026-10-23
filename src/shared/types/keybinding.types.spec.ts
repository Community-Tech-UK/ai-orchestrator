import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
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
