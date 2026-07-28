import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';

/**
 * Direction of a prompt-history recall step: `-1` walks back into history,
 * `1` walks forward towards the stashed draft.
 */
export type PromptRecallDirection = -1 | 1;

export interface PromptRecallDeps {
  entries: () => readonly PromptHistoryEntry[];
  recallIndex: () => number | null;
  recalledEntryId: () => string | null;
  apply: (entry: PromptHistoryEntry, index: number) => void;
  reset: (options: { restoreStash: boolean }) => void;
}

/**
 * Pure step logic for arrow-key prompt recall.
 *
 * Extracted from `InputPanelComponent` so the composer file stays inside its
 * size ratchet; behaviour is unchanged.
 *
 * Returns `true` when the step was handled (the caller should swallow the key).
 */
export function stepPromptRecall(deps: PromptRecallDeps, direction: PromptRecallDirection): boolean {
  const entries = deps.entries();
  if (entries.length === 0) {
    return false;
  }

  const currentIndex = deps.recallIndex();

  if (direction === -1) {
    const nextIndex = currentIndex === null
      ? 0
      : Math.min(currentIndex + 1, entries.length - 1);
    if (currentIndex === nextIndex && deps.recalledEntryId() === entries[nextIndex]?.id) {
      return false;
    }
    deps.apply(entries[nextIndex], nextIndex);
    return true;
  }

  if (currentIndex === null) {
    return false;
  }
  if (currentIndex === 0) {
    deps.reset({ restoreStash: true });
    return true;
  }

  deps.apply(entries[currentIndex - 1], currentIndex - 1);
  return true;
}
