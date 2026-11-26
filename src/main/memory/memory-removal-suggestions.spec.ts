import { describe, expect, it } from 'vitest';
import {
  REMOVAL_SUGGESTION_MIN_USES,
  memoryRemovalSuggestions,
  type WakeHintUsageView,
} from './memory-removal-suggestions';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-16T00:00:00Z');

const hint = (overrides: Partial<WakeHintUsageView>): WakeHintUsageView => ({
  id: 'hint-1',
  shownInWindow: 0,
  lastShownAt: NOW - DAY,
  createdAt: NOW - 90 * DAY,
  historyStartedAt: NOW - 90 * DAY,
  ...overrides,
});

describe('memoryRemovalSuggestions (part 7b)', () => {
  it('flags a changed source only at the threshold and only with a recorded source', () => {
    const base = { sourceRecorded: true, sourceStillMatches: false, lastShownAt: NOW - DAY };
    expect(memoryRemovalSuggestions([hint({ ...base, shownInWindow: REMOVAL_SUGGESTION_MIN_USES - 1 })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ ...base, shownInWindow: REMOVAL_SUGGESTION_MIN_USES })], NOW)).toEqual([
      { id: 'hint-1', reason: 'source-changed', label: 'source changed' },
    ]);
    // No recorded source (or not yet compared) never claims "source changed".
    expect(memoryRemovalSuggestions([hint({ shownInWindow: 50, sourceRecorded: false, sourceStillMatches: false })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ shownInWindow: 50, sourceRecorded: true })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ shownInWindow: 50, sourceRecorded: true, sourceStillMatches: true })], NOW)).toEqual([]);
  });

  it('flags notes not shown within a fully observed 60 days and never calls them unused', () => {
    const never = memoryRemovalSuggestions([hint({ id: 'old', shownInWindow: 0, lastShownAt: NOW - 61 * DAY })], NOW);
    expect(never).toEqual([{ id: 'old', reason: 'never-shown', label: 'never shown' }]);
    const fresh = memoryRemovalSuggestions([hint({ shownInWindow: 3, lastShownAt: NOW - DAY })], NOW);
    expect(fresh).toEqual([]);
    const unshown = memoryRemovalSuggestions([hint({ id: 'none', shownInWindow: 0, lastShownAt: null })], NOW);
    expect(unshown).toEqual([{ id: 'none', reason: 'never-shown', label: 'never shown' }]);
    expect(memoryRemovalSuggestions([hint({ lastShownAt: null, createdAt: NOW - DAY })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ lastShownAt: null, historyStartedAt: NOW - DAY })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ lastShownAt: null, createdAt: undefined })], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([hint({ lastShownAt: null, historyStartedAt: undefined })], NOW)).toEqual([]);
    for (const suggestion of [...never, ...unshown]) {
      expect(suggestion.label).not.toMatch(/never used|unused/i);
    }
  });
});
