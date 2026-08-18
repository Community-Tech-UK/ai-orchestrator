import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { Instance } from '../../core/state/instance.store';
import { isAutomationAttentionStatus } from '../../../../shared/types/instance-status-policy';

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

/**
 * True when a live automation-born session should be kept out of the project
 * rail because its automation is marked hidden.
 *
 * The escape hatch is the point of the feature: a hidden run that failed, or
 * that has parked waiting for a human, is always shown. Hiding a health check
 * that has silently stopped working would be strictly worse than the rail noise
 * hiding is meant to remove.
 */
export function isHiddenAutomationInstance(
  instance: Pick<Instance, 'status' | 'metadata'>,
  showHiddenAutomations: boolean,
): boolean {
  if (showHiddenAutomations || instance.metadata?.['automationHidden'] !== true) {
    return false;
  }
  return !isAutomationAttentionStatus(instance.status);
}

/**
 * Archived counterpart of {@link isHiddenAutomationInstance}.
 *
 * There is deliberately no status check here. `ConversationEndStatus` cannot
 * carry the answer — termination maps every non-`error` instance status to
 * `completed`, so a `failed` run and a clean run archive identically. The
 * verdict is resolved once, at archive time, by `HistoryManager`, which sets
 * the flag only when the runner recorded a clean finish. By the time an entry
 * exists, `isHiddenAutomation` already means "hidden *and* it ended fine".
 */
export function isHiddenAutomationHistoryEntry(
  entry: ConversationHistoryEntry,
  showHiddenAutomations: boolean,
): boolean {
  return !showHiddenAutomations && entry.isHiddenAutomation === true;
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
