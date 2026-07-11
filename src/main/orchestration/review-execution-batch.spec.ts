import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { LocalReviewOutcome } from '../review/local-reviewer';
import type { LocalModelInventoryEntry } from '../../shared/types/local-model-runtime.types';
import { resolveLocalReviewTarget, runReviewExecutionBatch } from './review-execution-batch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function review(reviewerId: string): ReviewResult {
  return {
    reviewerId,
    reviewType: 'structured',
    scores: {
      correctness: { reasoning: 'ok', score: 4, issues: [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: 'APPROVE',
    summary: 'Looks good.',
    timestamp: 1,
    durationMs: 1,
    parseSuccess: true,
  };
}

describe('runReviewExecutionBatch', () => {
  it('starts the local pass and the complete two-slot remote collection concurrently', async () => {
    const remote = deferred<ReviewResult[]>();
    const local = deferred<LocalReviewOutcome>();
    const collectRemoteReviews = vi.fn(() => remote.promise);
    const runLocalReview = vi.fn(() => local.promise);

    const pending = runReviewExecutionBatch({ collectRemoteReviews, runLocalReview });

    expect(collectRemoteReviews).toHaveBeenCalledOnce();
    expect(runLocalReview).toHaveBeenCalledOnce();
    remote.resolve([review('codex'), review('grok')]);
    local.resolve({ status: 'skipped', reason: 'not configured' });

    await expect(pending).resolves.toMatchObject({
      remoteReviews: [{ reviewerId: 'codex' }, { reviewerId: 'grok' }],
      localOutcome: { status: 'skipped' },
    });
  });

  it('isolates a local failure from successful remote reviews', async () => {
    const result = await runReviewExecutionBatch({
      collectRemoteReviews: async () => [review('codex'), review('grok')],
      runLocalReview: async () => { throw new Error('malformed local response'); },
    });

    expect(result.remoteReviews).toHaveLength(2);
    expect(result.localOutcome).toEqual({
      status: 'failed',
      reason: 'Local review failed: malformed local response',
    });
  });

  it('isolates a remote collection failure from the local outcome', async () => {
    const result = await runReviewExecutionBatch({
      collectRemoteReviews: async () => { throw new Error('remote transport failed'); },
      runLocalReview: async () => ({ status: 'used', review: review('local:qwen'), evidencePaths: ['src/a.ts'] }),
    });

    expect(result.remoteReviews).toEqual([]);
    expect(result.remoteError).toBe('remote transport failed');
    expect(result.localOutcome.status).toBe('used');
  });
});

function localEntry(overrides: Partial<LocalModelInventoryEntry> = {}): LocalModelInventoryEntry {
  return {
    selectorId: 'lm://this-device/ollama/ollama/qwen',
    source: 'this-device',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen',
    displayName: 'Qwen',
    healthy: true,
    loaded: true,
    capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
    discoveredAt: 1,
    ...overrides,
  };
}

describe('resolveLocalReviewTarget', () => {
  it('resolves a healthy selected this-device model', () => {
    const entry = localEntry();
    expect(resolveLocalReviewTarget({
      enabled: true,
      selectorId: entry.selectorId,
      inventory: [entry],
    })).toMatchObject({ status: 'ready', target: { selectorId: entry.selectorId } });
  });

  it.each([
    { name: 'disabled', enabled: false, selectorId: 'lm://missing', inventory: [localEntry()] },
    { name: 'missing selector', enabled: true, selectorId: '', inventory: [localEntry()] },
    { name: 'unavailable selector', enabled: true, selectorId: 'lm://missing', inventory: [localEntry()] },
    { name: 'unhealthy model', enabled: true, selectorId: localEntry().selectorId, inventory: [localEntry({ healthy: false })] },
    { name: 'unsupported worker model', enabled: true, selectorId: localEntry().selectorId, inventory: [localEntry({ source: 'worker-node', nodeId: 'node-1' })] },
    { name: 'cloud-backed model', enabled: true, selectorId: localEntry().selectorId, inventory: [localEntry({ modelId: 'qwen:cloud' })] },
  ])('skips a $name target with a visible reason', ({ enabled, selectorId, inventory }) => {
    const result = resolveLocalReviewTarget({ enabled, selectorId, inventory });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeTruthy();
  });

  it('skips the exact local selector used by the in-session builder', () => {
    const entry = localEntry();
    const result = resolveLocalReviewTarget({
      enabled: true,
      selectorId: entry.selectorId,
      builderSelectorId: entry.selectorId,
      inventory: [entry],
    });
    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('builder') });
  });

  it('automatically resolves the configured quality model by tag prefix when no selector is saved', () => {
    const entry = localEntry({ modelId: 'qwen3:32b' });
    expect(resolveLocalReviewTarget({
      enabled: true,
      selectorId: '',
      auxiliaryQualityModel: 'qwen3',
      inventory: [entry],
    })).toMatchObject({ status: 'ready', target: { selectorId: entry.selectorId, modelId: 'qwen3:32b' } });
  });

  it.each([
    { name: 'cloud', entry: localEntry({ modelId: 'qwen3:cloud' }) },
    { name: 'worker', entry: localEntry({ source: 'worker-node', nodeId: 'node-1' }) },
    { name: 'unhealthy', entry: localEntry({ healthy: false }) },
  ])('does not use a $name quality-model fallback', ({ entry }) => {
    const result = resolveLocalReviewTarget({
      enabled: true,
      selectorId: '',
      auxiliaryQualityModel: entry.modelId.replace(/:cloud$/u, ''),
      inventory: [entry],
    });
    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('quality') });
  });

  it('keeps an explicit selector authoritative instead of falling back to the quality model', () => {
    const entry = localEntry({ modelId: 'qwen3:32b' });
    expect(resolveLocalReviewTarget({
      enabled: true,
      selectorId: 'lm://missing',
      auxiliaryQualityModel: 'qwen3',
      inventory: [entry],
    })).toMatchObject({ status: 'skipped', selectorId: 'lm://missing' });
  });

  it('applies same-selector exclusion to an automatically resolved quality model', () => {
    const entry = localEntry({ modelId: 'qwen3:32b' });
    expect(resolveLocalReviewTarget({
      enabled: true,
      selectorId: '',
      auxiliaryQualityModel: 'qwen3',
      builderSelectorId: entry.selectorId,
      inventory: [entry],
    })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('builder') });
  });
});
