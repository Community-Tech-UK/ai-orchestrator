import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import type { ReviewExecutionHost } from '../review/review-execution-host';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../util/cleanup-registry', () => ({
  registerCleanup: vi.fn(),
}));

vi.mock('../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({
    isPaused: () => false,
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewEnabled: true,
      crossModelReviewDepth: 'structured',
      crossModelReviewMaxReviewers: 2,
      crossModelReviewProviders: [],
      crossModelReviewTimeout: 30,
      crossModelReviewTypes: ['code', 'plan', 'architecture'],
    }),
  }),
}));

vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
    }),
  },
}));

function reviewerJson(issue: string): string {
  return JSON.stringify({
    correctness: { reasoning: 'The diff misses a null guard.', score: 2, issues: [issue] },
    completeness: { reasoning: 'ok', score: 4, issues: [] },
    security: { reasoning: 'ok', score: 4, issues: [] },
    consistency: { reasoning: 'ok', score: 4, issues: [] },
    overall_verdict: 'CONCERNS',
    summary: 'One correctness concern.',
  });
}

describe('CrossModelReviewService headless review', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
  });

  it('runs reviewers through a narrow host without an InstanceManager', async () => {
    const dispatchReviewerPrompt = vi.fn(async (provider: string) => {
      if (provider === 'codex') {
        throw new Error('CLI unavailable');
      }
      return reviewerJson('Add a null check before reading payload.value.');
    });
    const host: ReviewExecutionHost = {
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review the local diff.',
      dispatchReviewerPrompt,
    };
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost(host);

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: 'diff --git a/src/handler.ts b/src/handler.ts',
      taskDescription: 'Review the local diff.',
      reviewers: ['gemini', 'codex'],
      timeoutSeconds: 30,
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'gemini',
      expect.stringContaining('Review the local diff.'),
      '/repo',
      expect.any(AbortSignal),
    );
    expect(result.reviewers).toEqual([
      { provider: 'gemini', status: 'used' },
      { provider: 'codex', status: 'failed', reason: 'CLI unavailable' },
    ]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      title: 'gemini correctness concern',
      body: 'Add a null check before reading payload.value.',
      severity: 'medium',
    }));
    expect(result.infrastructureErrors).toEqual([]);
  });

  it('returns stable JSON-shaped results when no reviewers are available', async () => {
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(),
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: 'diff',
      taskDescription: 'Review',
      reviewers: [],
    });

    expect(result.reviewers).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.infrastructureErrors).toEqual([]);
    expect(result.summary).toContain('No reviewers available');
  });
});
