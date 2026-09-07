/**
 * N3 — the reducer keyed by run AND iteration, because one run can stall more
 * than once and each stall gets its own fan-out round.
 */
import { describe, expect, it } from 'vitest';

import {
  branchEpisodeFor,
  branchEpisodeKey,
  createBranchEpisodeStore,
  upsertBranchEpisode,
  type LoopBranchEpisode,
  type LoopBranchEpisodes,
} from './loop-store-branch-episodes';

const episode = (over: Partial<LoopBranchEpisode> = {}): LoopBranchEpisode => ({
  loopRunId: 'loop-1',
  seq: 3,
  adopted: true,
  reason: 'candidate 2 passed verify',
  candidateCount: 4,
  ...over,
});

const empty = (): LoopBranchEpisodes => new Map<string, LoopBranchEpisode>();

describe('upsertBranchEpisode', () => {
  it('records a round against its run and iteration', () => {
    const episodes = upsertBranchEpisode(empty(), episode());
    expect(branchEpisodeFor(episodes, 'loop-1', 3)?.candidateCount).toBe(4);
  });

  it('keeps rounds for different iterations of the same run apart', () => {
    let episodes = upsertBranchEpisode(empty(), episode({ seq: 3 }));
    episodes = upsertBranchEpisode(episodes, episode({ seq: 7, candidateCount: 2 }));
    expect(branchEpisodeFor(episodes, 'loop-1', 3)?.candidateCount).toBe(4);
    expect(branchEpisodeFor(episodes, 'loop-1', 7)?.candidateCount).toBe(2);
  });

  it('keeps rounds for different runs apart', () => {
    let episodes = upsertBranchEpisode(empty(), episode({ loopRunId: 'loop-1' }));
    episodes = upsertBranchEpisode(episodes, episode({ loopRunId: 'loop-2', adopted: false }));
    expect(branchEpisodeFor(episodes, 'loop-1', 3)?.adopted).toBe(true);
    expect(branchEpisodeFor(episodes, 'loop-2', 3)?.adopted).toBe(false);
  });

  /** A re-emitted event is a retry of the same round, not a second one. */
  it('replaces rather than appends for the same run and iteration', () => {
    let episodes = upsertBranchEpisode(empty(), episode({ totalCostUsd: 1 }));
    episodes = upsertBranchEpisode(episodes, episode({ totalCostUsd: 2 }));
    expect(episodes.size).toBe(1);
    expect(branchEpisodeFor(episodes, 'loop-1', 3)?.totalCostUsd).toBe(2);
  });

  it('does not mutate the map it was given', () => {
    const before = empty();
    upsertBranchEpisode(before, episode());
    expect(before.size).toBe(0);
  });
});

describe('branchEpisodeFor', () => {
  it('is null when nothing ran for that iteration', () => {
    expect(branchEpisodeFor(upsertBranchEpisode(empty(), episode()), 'loop-1', 9)).toBeNull();
  });

  it('is null for a missing run id or seq rather than throwing', () => {
    const episodes = upsertBranchEpisode(empty(), episode());
    expect(branchEpisodeFor(episodes, null, 3)).toBeNull();
    expect(branchEpisodeFor(episodes, 'loop-1', null)).toBeNull();
  });

  /** seq 0 is a real iteration, and must not be treated as absent. */
  it('finds a round for iteration zero', () => {
    const episodes = upsertBranchEpisode(empty(), episode({ seq: 0 }));
    expect(branchEpisodeFor(episodes, 'loop-1', 0)).not.toBeNull();
  });
});

describe('branchEpisodeKey', () => {
  it('separates run and iteration unambiguously', () => {
    expect(branchEpisodeKey('loop-1', 3)).toBe('loop-1::3');
  });
});

describe('createBranchEpisodeStore', () => {
  it('records and reads back through the signal', () => {
    const store = createBranchEpisodeStore();
    expect(store.get('loop-1', 3)).toBeNull();
    store.record(episode());
    expect(store.get('loop-1', 3)?.candidateCount).toBe(4);
  });
});
