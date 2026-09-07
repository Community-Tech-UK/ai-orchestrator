import { signal } from '@angular/core';

/**
 * N3 — branch-and-select rounds, kept per loop run and iteration.
 *
 * `loop:branch-select` has been emitted by the coordinator since branch-select
 * shipped and nothing has ever listened: no preload listener existed, so the
 * renderer could not see a fan-out round at all. An operator whose loop quietly
 * spawned four parallel candidates, ran four CLI turns and adopted one had no
 * way to know it happened, let alone what it cost.
 *
 * A separate pure module rather than logic inside `loop.store.ts`, which is
 * already deep into its allowlisted LOC tolerance — and a reducer is easier to
 * test than a store method anyway.
 */

export interface LoopBranchEpisode {
  loopRunId: string;
  /** The iteration this round ran for. */
  seq: number;
  adopted: boolean;
  reason: string;
  candidateCount: number;
  winnerId?: string;
  winnerProvider?: string;
  scores?: Record<string, number>;
  totalCostUsd?: number;
}

/** Keyed by `loopRunId::seq` — a run can have several rounds, one per stall. */
export type LoopBranchEpisodes = ReadonlyMap<string, LoopBranchEpisode>;

export function branchEpisodeKey(loopRunId: string, seq: number): string {
  return `${loopRunId}::${seq}`;
}

/**
 * Record a round, replacing any earlier one for the same iteration.
 *
 * Replace rather than append: branch-select runs at most once per stall for a
 * given iteration, and a re-emitted event is a retry of the same round, not a
 * second one. Appending would double-count the spend.
 */
export function upsertBranchEpisode(
  episodes: LoopBranchEpisodes,
  episode: LoopBranchEpisode,
): LoopBranchEpisodes {
  const next = new Map(episodes);
  next.set(branchEpisodeKey(episode.loopRunId, episode.seq), episode);
  return next;
}

export function branchEpisodeFor(
  episodes: LoopBranchEpisodes,
  loopRunId: string | null | undefined,
  seq: number | null | undefined,
): LoopBranchEpisode | null {
  if (!loopRunId || seq === null || seq === undefined) return null;
  return episodes.get(branchEpisodeKey(loopRunId, seq)) ?? null;
}

/**
 * **Episodes are deliberately never evicted.**
 *
 * A first version had a `clearBranchEpisodesForRun`, and it had no safe caller:
 * the obvious hook is the run reaching a terminal state, but the card renders
 * in the per-iteration inspector, which is exactly what an operator opens
 * AFTER a run ends. Clearing there would delete the data the UI exists to show.
 *
 * So the map grows for the renderer session's lifetime and is never evicted.
 * Stated precisely rather than waved away: branch-select can fire on EVERY
 * CRITICAL no-progress stall in a run, each with its own `seq` key, so a single
 * long run with exploration on can add entries up to its iteration cap, and a
 * long-lived session accumulates across runs. What keeps that small is that
 * exploration is opt-in and off by default, and CRITICAL stalls are rare by
 * construction — not any bound in this code. An unwired cleanup function would
 * have been an orphan pretending the question was handled; this comment is the
 * honest version of the same answer.
 */

export interface BranchEpisodeStore {
  record: (episode: LoopBranchEpisode) => void;
  get: (loopRunId: string | null, seq: number | null) => LoopBranchEpisode | null;
}

/**
 * The signal lives here rather than in `loop.store.ts`, which is deep into its
 * allowlisted LOC tolerance — adding the state there pushed it over the ratchet.
 */
export function createBranchEpisodeStore(): BranchEpisodeStore {
  const episodes = signal<LoopBranchEpisodes>(new Map<string, LoopBranchEpisode>());
  return {
    record: (episode) => episodes.update((current) => upsertBranchEpisode(current, episode)),
    get: (loopRunId, seq) => branchEpisodeFor(episodes(), loopRunId, seq),
  };
}
