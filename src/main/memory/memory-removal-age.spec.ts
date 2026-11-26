import { describe, expect, it } from 'vitest';
import { memoryRemovalSuggestions, type WakeHintUsageView } from './memory-removal-suggestions';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const note: WakeHintUsageView = {
  id: 'old-note', createdAt: NOW - 90 * DAY, historyStartedAt: NOW - 90 * DAY,
  shownInWindow: 0, lastShownAt: null,
};

describe('removal suggestions respect the plan’s 60-day inactivity window', () => {
  it('keeps notes that were added or last shown between 30 and 60 days ago', () => {
    expect(memoryRemovalSuggestions([{ ...note, createdAt: NOW - 31 * DAY }], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([{ ...note, lastShownAt: NOW - 45 * DAY }], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([{ ...note, lastShownAt: NOW - 60 * DAY }], NOW)).toEqual([]);
  });

  it('requires a full observed 60 days rather than inventing missing legacy history', () => {
    expect(memoryRemovalSuggestions([{ ...note, historyStartedAt: NOW - 31 * DAY }], NOW)).toEqual([]);
    expect(memoryRemovalSuggestions([{ ...note, lastShownAt: NOW - 61 * DAY }], NOW)).toEqual([
      { id: 'old-note', reason: 'never-shown', label: 'never shown' },
    ]);
  });
});
