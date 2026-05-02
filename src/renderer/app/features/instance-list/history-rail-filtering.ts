import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

export type HistoryVisibilityMode = 'relevant' | 'all';
export type HistoryTimeWindow = 'all' | 'day' | '3-days' | 'week' | '2-weeks' | 'month';

const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_TIME_WINDOW_DAYS: Record<Exclude<HistoryTimeWindow, 'all'>, number> = {
  day: 1,
  '3-days': 3,
  week: 7,
  '2-weeks': 14,
  month: 30,
};

export interface HistoryOnlyProjectVisibilityInput {
  mode: HistoryVisibilityMode;
  hasTextFilter: boolean;
  hasDraft: boolean;
  isPinnedProject: boolean;
  selectedHistoryEntryId: string | null;
  pinnedHistoryIds: ReadonlySet<string>;
  historyItems: readonly ConversationHistoryEntry[];
}

export function isNativeImportedHistoryEntry(entry: ConversationHistoryEntry): boolean {
  return entry.importSource === 'native-claude';
}

export function getHistoryTimeWindowCutoff(
  window: HistoryTimeWindow,
  now = Date.now()
): number | null {
  if (window === 'all') {
    return null;
  }

  return now - HISTORY_TIME_WINDOW_DAYS[window] * DAY_MS;
}

export function isWithinHistoryTimeWindow(
  timestamp: number,
  window: HistoryTimeWindow,
  now = Date.now()
): boolean {
  const cutoff = getHistoryTimeWindowCutoff(window, now);
  return cutoff === null || timestamp >= cutoff;
}

export function shouldShowHistoryOnlyProject(
  input: HistoryOnlyProjectVisibilityInput
): boolean {
  if (input.mode === 'all' || input.hasTextFilter) {
    return true;
  }

  if (input.hasDraft || input.isPinnedProject) {
    return true;
  }

  if (input.historyItems.length === 0) {
    return true;
  }

  if (
    input.selectedHistoryEntryId &&
    input.historyItems.some((entry) => entry.id === input.selectedHistoryEntryId)
  ) {
    return true;
  }

  if (input.historyItems.some((entry) => input.pinnedHistoryIds.has(entry.id))) {
    return true;
  }

  return input.historyItems.some((entry) => !isNativeImportedHistoryEntry(entry));
}
