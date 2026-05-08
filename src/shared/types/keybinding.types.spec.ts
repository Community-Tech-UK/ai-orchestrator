import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
  matchesKeybindingWhen,
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
