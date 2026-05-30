/**
 * LF-5 (loopfixex.md) — branch-and-select gating, selection, and orchestration.
 *
 * The real fan-out drives worktrees + live CLI (not exercisable in a unit
 * test), so the orchestration is tested with injectable mock deps; the gating
 * and selection are pure.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  pickCandidateProvider,
  runBranchSelect,
  selectWinner,
  shouldRunBranchSelect,
  type BranchCandidate,
  type BranchSelectDeps,
  type BranchSelectInput,
} from './loop-branch-select';
import { defaultLoopConfig, defaultLoopExplorationConfig } from '../../shared/types/loop.types';

function baseInput(over: Partial<BranchSelectInput> = {}): BranchSelectInput {
  const cfg = defaultLoopConfig('/ws', 'goal');
  return {
    loopRunId: 'loop-1',
    workspaceCwd: '/ws',
    goal: 'goal',
    exploration: { ...defaultLoopExplorationConfig(), enabled: true },
    caps: { ...cfg.caps, maxCostCents: 1000 },
    spentTokens: 0,
    spentCents: 0,
    prompt: 'do the iteration',
    provider: 'claude',
    verifyCommand: 'true',
    verifyTimeoutMs: 60_000,
    iterationTimeoutMs: 60_000,
    ...over,
  };
}

function cand(id: string, verifyPassed: boolean, filesChanged = 1): BranchCandidate {
  return { id, provider: 'claude', workdir: `/wt/${id}`, verifyPassed, filesChanged, summary: `${id} summary` };
}

describe('pickCandidateProvider (LF-5)', () => {
  it('returns the base provider when crossModel is off', () => {
    expect(pickCandidateProvider('claude', false, 0)).toBe('claude');
    expect(pickCandidateProvider('codex', false, 3)).toBe('codex');
  });
  it('alternates Claude/Codex when crossModel is on', () => {
    expect(pickCandidateProvider('claude', true, 0)).toBe('claude');
    expect(pickCandidateProvider('claude', true, 1)).toBe('codex');
    expect(pickCandidateProvider('claude', true, 2)).toBe('claude');
  });
});

describe('shouldRunBranchSelect (LF-5)', () => {
  it('does not run when disabled', () => {
    expect(shouldRunBranchSelect(baseInput({ exploration: { ...defaultLoopExplorationConfig(), enabled: false } })).run).toBe(false);
  });
  it('requires a non-null cost cap', () => {
    const r = shouldRunBranchSelect(baseInput({ caps: { ...defaultLoopConfig('/ws', 'g').caps, maxCostCents: null } }));
    expect(r.run).toBe(false);
    expect(r.reason).toContain('cost cap');
  });
  it('does not run when the cost cap is already exhausted', () => {
    expect(shouldRunBranchSelect(baseInput({ caps: { ...defaultLoopConfig('/ws', 'g').caps, maxCostCents: 1000 }, spentCents: 1000 })).run).toBe(false);
  });
  it('runs when enabled with a cost cap and headroom', () => {
    expect(shouldRunBranchSelect(baseInput()).run).toBe(true);
  });
});

describe('selectWinner (LF-5)', () => {
  it('picks no winner when none passed verify', () => {
    expect(selectWinner([cand('a', false), cand('b', false)]).winner).toBeNull();
  });
  it('prefers a verify-passing candidate; breaks ties by files changed', () => {
    const out = selectWinner([cand('a', false, 9), cand('b', true, 2), cand('c', true, 8)]);
    expect(out.winner?.id).toBe('c');
  });
  it('uses list-wise scores when provided', () => {
    const out = selectWinner([cand('a', true, 1), cand('b', true, 1)], { a: 0.2, b: 0.9 });
    expect(out.winner?.id).toBe('b');
  });
});

describe('runBranchSelect orchestration (LF-5)', () => {
  function deps(over: Partial<BranchSelectDeps> = {}): BranchSelectDeps {
    return {
      fanout: vi.fn(async () => [cand('a', false), cand('b', true, 5)]),
      adopt: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      ...over,
    };
  }

  it('adopts the winning candidate and always cleans up', async () => {
    const d = deps();
    const result = await runBranchSelect(baseInput(), d);
    expect(result.adopted).toBe(true);
    expect(result.winnerId).toBe('b');
    expect(d.adopt).toHaveBeenCalledTimes(1);
    expect(d.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not adopt (but still cleans up) when no candidate passes verify', async () => {
    const d = deps({ fanout: vi.fn(async () => [cand('a', false), cand('b', false)]) });
    const result = await runBranchSelect(baseInput(), d);
    expect(result.adopted).toBe(false);
    expect(d.adopt).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns adopted:false without fanning out when the gate fails', async () => {
    const d = deps();
    const result = await runBranchSelect(
      baseInput({ exploration: { ...defaultLoopExplorationConfig(), enabled: false } }),
      d,
    );
    expect(result.adopted).toBe(false);
    expect(d.fanout).not.toHaveBeenCalled();
    expect(d.cleanup).not.toHaveBeenCalled();
  });

  it('cleans up worktrees even when adopt throws', async () => {
    const d = deps({ adopt: vi.fn(async () => { throw new Error('merge conflict'); }) });
    const result = await runBranchSelect(baseInput(), d);
    expect(result.adopted).toBe(false);
    expect(d.cleanup).toHaveBeenCalledTimes(1);
  });

  it('applies list-wise scoring when the selector requests it', async () => {
    const listwiseScore = vi.fn(async () => ({ a: 0.1, b: 0.95 }));
    const d = deps({
      fanout: vi.fn(async () => [cand('a', true, 9), cand('b', true, 1)]),
      listwiseScore,
    });
    const result = await runBranchSelect(baseInput({ exploration: { ...defaultLoopExplorationConfig(), enabled: true, selector: 'verify+listwise' } }), d);
    expect(listwiseScore).toHaveBeenCalledTimes(1);
    expect(result.winnerId).toBe('b'); // list-wise score beats the files heuristic
  });
});
