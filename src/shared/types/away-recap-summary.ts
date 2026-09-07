/**
 * N12 — the card→recap summariser, shared between main and the renderer.
 *
 * Main builds a recap from the loop store; the renderer needs to build one too,
 * because a banner that is still on screen must absorb a later run rather than
 * be replaced by it (see `away-recap-banner.component.ts`). Both need identical
 * ordering, counts and headline wording, so the summarising lives here once
 * instead of being written a second time in the renderer and drifting the first
 * time either sentence is edited.
 *
 * Pure and dependency-free: no Electron, no loop store, no IPC. That is what
 * makes it importable from the renderer at all.
 */

/** Outcome classes, ordered by how much they want a human. */
export type AwayOutcome = 'needs-you' | 'stopped-short' | 'finished';

export interface AwayRunCard {
  runId: string;
  goal: string;
  outcome: AwayOutcome;
  status: string;
  iterations: number;
  durationMs: number;
  costCents: number;
  outstandingCount: number;
  endReason: string | null;
}

export interface AwayRecap {
  /** Cards, most-wanting-attention first. */
  cards: AwayRunCard[];
  finished: number;
  stoppedShort: number;
  needsYou: number;
  totalCostCents: number;
  /** One-line summary safe to put in a notification or a header. */
  headline: string;
}

export const AWAY_OUTCOME_ORDER: Record<AwayOutcome, number> = {
  'needs-you': 0,
  'stopped-short': 1,
  finished: 2,
};

/**
 * Sort cards, count them and write the headline.
 *
 * Returns null for an empty set so callers do not have to special-case "0 loop
 * runs ended:" — there is no such sentence worth showing.
 */
export function summariseAwayCards(input: readonly AwayRunCard[]): AwayRecap | null {
  if (input.length === 0) return null;

  const cards = [...input].sort((a, b) =>
    AWAY_OUTCOME_ORDER[a.outcome] - AWAY_OUTCOME_ORDER[b.outcome]
    || b.durationMs - a.durationMs);

  const needsYou = cards.filter((c) => c.outcome === 'needs-you').length;
  const stoppedShort = cards.filter((c) => c.outcome === 'stopped-short').length;
  const finished = cards.filter((c) => c.outcome === 'finished').length;
  const totalCostCents = cards.reduce((sum, c) => sum + c.costCents, 0);

  // Lead with what needs a person. "3 runs finished" is a worse first sentence
  // than "1 needs you" when both are true.
  const parts: string[] = [];
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? 's' : ''} you`);
  if (stoppedShort > 0) parts.push(`${stoppedShort} stopped short`);
  if (finished > 0) parts.push(`${finished} finished`);

  return {
    cards,
    finished,
    stoppedShort,
    needsYou,
    totalCostCents,
    headline: `${cards.length} loop run${cards.length === 1 ? '' : 's'} ended: ${parts.join(', ')}.`,
  };
}

/**
 * Fold a newly-arrived recap into one already on screen.
 *
 * Why this exists: the banner's `awaySince` boundary advances every time a
 * recap is shown, so a run reported in an earlier recap can never be returned
 * by a later query. Overwriting therefore did not merely reorder the banner, it
 * destroyed information permanently — two ordinary alt-tabs without an
 * intervening dismissal were enough to replace an unread `needs-you` card with
 * a less urgent `finished` one, with no way to get it back.
 *
 * `existing` wins on a duplicate `runId`. A run's terminal record does not
 * change after it ends, so the two copies are the same facts; keeping the first
 * avoids re-ordering a card the user has already read past.
 */
export function mergeAwayRecaps(
  existing: AwayRecap | null,
  incoming: AwayRecap | null,
): AwayRecap | null {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const seen = new Set(existing.cards.map((c) => c.runId));
  const merged = [
    ...existing.cards,
    ...incoming.cards.filter((c) => !seen.has(c.runId)),
  ];
  return summariseAwayCards(merged);
}
