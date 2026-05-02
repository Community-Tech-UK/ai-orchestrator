import { describe, expect, it } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import {
  getHistoryTimeWindowCutoff,
  isWithinHistoryTimeWindow,
  shouldShowHistoryOnlyProject,
} from './history-rail-filtering';

function historyEntry(
  id: string,
  overrides: Partial<ConversationHistoryEntry> = {}
): ConversationHistoryEntry {
  return {
    id,
    displayName: 'Imported task',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/Users/me/work/imported-project',
    messageCount: 2,
    firstUserMessage: 'Imported native Claude task',
    lastUserMessage: 'Imported native Claude follow-up',
    status: 'completed',
    originalInstanceId: `imported-${id}`,
    parentId: null,
    sessionId: id,
    provider: 'claude',
    ...overrides,
  };
}

describe('history rail filtering', () => {
  it('resolves activity time-window cutoffs', () => {
    const now = Date.UTC(2026, 4, 2, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;

    expect(getHistoryTimeWindowCutoff('all', now)).toBeNull();
    expect(getHistoryTimeWindowCutoff('day', now)).toBe(now - day);
    expect(getHistoryTimeWindowCutoff('3-days', now)).toBe(now - 3 * day);
    expect(getHistoryTimeWindowCutoff('week', now)).toBe(now - 7 * day);
    expect(getHistoryTimeWindowCutoff('2-weeks', now)).toBe(now - 14 * day);
    expect(getHistoryTimeWindowCutoff('month', now)).toBe(now - 30 * day);
  });

  it('matches timestamps against the selected activity time window', () => {
    const now = Date.UTC(2026, 4, 2, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;

    expect(isWithinHistoryTimeWindow(now - day + 1, 'day', now)).toBe(true);
    expect(isWithinHistoryTimeWindow(now - day - 1, 'day', now)).toBe(false);
    expect(isWithinHistoryTimeWindow(now - 365 * day, 'all', now)).toBe(true);
  });

  it('hides native-only history projects in relevant mode', () => {
    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems: [
          historyEntry('native-1', { importSource: 'native-claude' }),
          historyEntry('native-2', { importSource: 'native-claude' }),
        ],
      })
    ).toBe(false);
  });

  it('shows native-only history projects when the user searches or switches to all history', () => {
    const historyItems = [historyEntry('native-1', { importSource: 'native-claude' })];

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: true,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'all',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);
  });

  it('keeps native-only history projects when the user pinned or selected them', () => {
    const historyItems = [historyEntry('native-1', { importSource: 'native-claude' })];

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(['native-1']),
        historyItems,
      })
    ).toBe(true);

    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: 'native-1',
        pinnedHistoryIds: new Set<string>(),
        historyItems,
      })
    ).toBe(true);
  });

  it('keeps regular orchestrator history projects in relevant mode', () => {
    expect(
      shouldShowHistoryOnlyProject({
        mode: 'relevant',
        hasTextFilter: false,
        hasDraft: false,
        isPinnedProject: false,
        selectedHistoryEntryId: null,
        pinnedHistoryIds: new Set<string>(),
        historyItems: [historyEntry('orchestrator-1')],
      })
    ).toBe(true);
  });
});
