/**
 * Memory-note removal suggestions (October follow-ups part 7b, changes 2-3).
 *
 * Pure rule module for the memory page's "Suggested for removal" fold. Two
 * triggers, never automatic:
 *  - "source changed": shown at least 10 times in 30 days AND its recorded
 *    source no longer matches (needs the note's recorded source — the fold's
 *    caller supplies the comparison);
 *  - "never shown": a full observed 60 days without a showing.
 *
 * Wake notes cannot report whether they were *used*, only whether they were
 * shown, so the wording is "never shown" and "source changed" — never
 * "never used" (change 3).
 */

export const REMOVAL_SUGGESTION_MIN_USES = 10;
export const REMOVAL_SUGGESTION_USE_WINDOW_DAYS = 30;
export const REMOVAL_SUGGESTION_NEVER_SHOWN_DAYS = 60;

export interface WakeHintUsageView {
  id: string;
  /** How often the note was shown in the last `REMOVAL_SUGGESTION_USE_WINDOW_DAYS`. */
  shownInWindow: number;
  /** When the note was last shown (ms), or null when never shown. */
  lastShownAt: number | null;
  createdAt?: number;
  historyStartedAt?: number;
  /** False when the note records no source, or its source is not comparable yet. */
  sourceRecorded?: boolean;
  /** True/False once the recorded source was compared; undefined = not compared. */
  sourceStillMatches?: boolean;
}

export type MemoryRemovalReason = 'never-shown' | 'source-changed';

export interface MemoryRemovalSuggestion {
  id: string;
  reason: MemoryRemovalReason;
  label: 'never shown' | 'source changed';
}

const DAY = 86_400_000;

export function memoryRemovalSuggestions(
  hints: readonly WakeHintUsageView[],
  now: number,
): MemoryRemovalSuggestion[] {
  const suggestions: MemoryRemovalSuggestion[] = [];
  for (const hint of hints) {
    const sourceChanged =
      hint.shownInWindow >= REMOVAL_SUGGESTION_MIN_USES
      && hint.sourceRecorded === true
      && hint.sourceStillMatches === false;
    if (sourceChanged) {
      suggestions.push({ id: hint.id, reason: 'source-changed', label: 'source changed' });
      continue;
    }
    const cutoff = now - REMOVAL_SUGGESTION_NEVER_SHOWN_DAYS * DAY;
    const neverShown = hint.shownInWindow === 0
      && (hint.createdAt ?? now) <= cutoff
      && (hint.historyStartedAt ?? now) <= cutoff
      && (hint.lastShownAt === null || hint.lastShownAt < cutoff);
    if (neverShown) {
      suggestions.push({ id: hint.id, reason: 'never-shown', label: 'never shown' });
    }
  }
  return suggestions;
}
