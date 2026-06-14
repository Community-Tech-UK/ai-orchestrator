import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../vcs/remotes/github-pr-poller', () => ({
  fetchPREnrichmentBatch: vi.fn(),
}));

import {
  verifyMergePreconditions,
  performAutoMerge,
  type AutoMergeEngineContext,
  type MergeFn,
} from '../reaction-auto-merge';
import { fetchPREnrichmentBatch } from '../../vcs/remotes/github-pr-poller';
import type { InstanceReactionState, PREnrichmentData, ReactionEvent } from '../reaction.types';

function makePRData(overrides?: Partial<PREnrichmentData>): PREnrichmentData {
  return {
    owner: 'test-org', repo: 'test-repo', number: 42,
    url: 'https://github.com/test-org/test-repo/pull/42',
    state: 'open', ciStatus: 'passing', ciChecks: [],
    reviewDecision: 'approved', mergeable: true, hasConflicts: false,
    fetchedAt: 0, ...overrides,
  };
}

function makeState(): InstanceReactionState {
  return { instanceId: 'inst-1', prUrl: makePRData().url, reactionTrackers: new Map(), startedAt: 0 };
}

function makeCtx(): AutoMergeEngineContext & {
  _emitted: { name: string; payload: unknown }[];
  emit: ReturnType<typeof vi.fn>;
  notifyHuman: ReturnType<typeof vi.fn>;
} {
  const emitted: { name: string; payload: unknown }[] = [];
  return {
    _emitted: emitted,
    emitEvent: vi.fn((s: InstanceReactionState, _e, _d, m: string): ReactionEvent => ({
      id: 'e', type: 'merge.ready', priority: 'action', instanceId: s.instanceId,
      timestamp: 0, data: {}, message: m,
    })),
    notifyHuman: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn((name: string, payload: unknown) => emitted.push({ name, payload })),
  };
}

function mockLiveRefetch(data: PREnrichmentData | null): void {
  const map = new Map<string, PREnrichmentData>();
  if (data) map.set(`${data.owner}/${data.repo}#${data.number}`, data);
  vi.mocked(fetchPREnrichmentBatch).mockResolvedValueOnce(map);
}

describe('verifyMergePreconditions', () => {
  it('passes when open, CI passing, approved, mergeable, no conflicts', () => {
    expect(verifyMergePreconditions(makePRData())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ['not open', { state: 'closed' as const }],
    ['CI not passing', { ciStatus: 'failing' as const }],
    ['not approved', { reviewDecision: 'changes_requested' as const }],
    ['not mergeable', { mergeable: false }],
    ['has conflicts', { hasConflicts: true }],
  ])('fails when %s', (_label, override) => {
    const result = verifyMergePreconditions(makePRData(override));
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('reports every failing dimension at once', () => {
    const result = verifyMergePreconditions(
      makePRData({ state: 'closed', ciStatus: 'failing', mergeable: false }),
    );
    expect(result.reasons).toHaveLength(3);
  });
});

describe('performAutoMerge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges when live re-fetch confirms preconditions', async () => {
    mockLiveRefetch(makePRData());
    const merge = vi.fn<MergeFn>().mockResolvedValue(undefined);
    const ctx = makeCtx();

    const result = await performAutoMerge(ctx, makeState(), 'merge.ready', makePRData(), 'ready', merge);

    expect(merge).toHaveBeenCalledWith('test-org/test-repo', 42);
    expect(result.success).toBe(true);
    expect(ctx._emitted.find((e) => e.name === 'reaction:auto-merged')).toBeDefined();
    const audit = ctx._emitted.find((e) => e.name === 'reaction:auto-merge-audit');
    expect((audit?.payload as { outcome: string }).outcome).toBe('merged');
  });

  it('does NOT merge when live state regressed (CI now failing)', async () => {
    // Stale snapshot looked green; live re-fetch shows CI failing.
    mockLiveRefetch(makePRData({ ciStatus: 'failing' }));
    const merge = vi.fn<MergeFn>().mockResolvedValue(undefined);
    const ctx = makeCtx();

    const result = await performAutoMerge(ctx, makeState(), 'merge.ready', makePRData(), 'ready', merge);

    expect(merge).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(ctx.notifyHuman).toHaveBeenCalled();
    const audit = ctx._emitted.find((e) => e.name === 'reaction:auto-merge-audit');
    expect((audit?.payload as { outcome: string }).outcome).toBe('skipped');
  });

  it('aborts (does not merge) when live state cannot be confirmed', async () => {
    mockLiveRefetch(null); // empty map → could not re-fetch
    const merge = vi.fn<MergeFn>().mockResolvedValue(undefined);
    const ctx = makeCtx();

    const result = await performAutoMerge(ctx, makeState(), 'merge.ready', makePRData(), 'ready', merge);

    expect(merge).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    const audit = ctx._emitted.find((e) => e.name === 'reaction:auto-merge-audit');
    expect((audit?.payload as { outcome: string }).outcome).toBe('skipped');
  });

  it('audits a failed merge and notifies a human', async () => {
    mockLiveRefetch(makePRData());
    const merge = vi.fn<MergeFn>().mockRejectedValue(new Error('merge blocked by branch protection'));
    const ctx = makeCtx();

    const result = await performAutoMerge(ctx, makeState(), 'merge.ready', makePRData(), 'ready', merge);

    expect(result.success).toBe(false);
    expect(ctx.notifyHuman).toHaveBeenCalled();
    const audit = ctx._emitted.find((e) => e.name === 'reaction:auto-merge-audit');
    expect((audit?.payload as { outcome: string }).outcome).toBe('failed');
  });
});
