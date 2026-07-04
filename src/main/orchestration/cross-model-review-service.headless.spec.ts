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

// An existing directory — the headless path validates cwd before dispatch,
// so fake paths like '/repo' would silently fall back to process.cwd().
const REPO_CWD = process.cwd();
const MISSING_REMOTE_WINDOWS_CWD = 'C:\\__aio_missing_remote_node_workspace__\\repo';

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
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review the local diff.',
      dispatchReviewerPrompt,
    };
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost(host);

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: 'diff --git a/src/handler.ts b/src/handler.ts',
      taskDescription: 'Review the local diff.',
      reviewers: ['gemini', 'codex'],
      timeoutSeconds: 30,
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'gemini',
      expect.stringContaining('Review the local diff.'),
      REPO_CWD,
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

  it('truncates an oversized payload before dispatching to the reviewer', async () => {
    // A long loop's cumulative git diff can be hundreds of KB. Shipping it raw
    // overflows the reviewer CLI's context and yields unparseable output. The
    // headless path must bound the payload like the in-session path does.
    let dispatchedPrompt = '';
    const dispatchReviewerPrompt = vi.fn(async (_provider: string, prompt: string) => {
      dispatchedPrompt = prompt;
      return reviewerJson('finding');
    });
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const hugeDiff = 'x'.repeat(200_000);
    await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: hugeDiff,
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    // The 200k-char payload must not be forwarded whole.
    expect(dispatchedPrompt.length).toBeLessThan(hugeDiff.length);
    expect(dispatchedPrompt).toContain('truncated');
  });

  it('reports the response length when a reviewer returns unparseable output', async () => {
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(async () => 'I think this looks fine to me, ship it!'),
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: 'diff',
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    expect(result.reviewers).toEqual([
      { provider: 'gemini', status: 'failed', reason: expect.stringContaining('unparseable output') },
    ]);
    expect(result.reviewers[0].reason).toMatch(/\d+ chars/);
    expect(result.infrastructureErrors).toHaveLength(1);
  });

  it('validates the cwd before dispatch and falls back to process.cwd() for a missing path', async () => {
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('finding'));
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => undefined,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      // A remote-node Windows path — does not exist on this machine. Spawning
      // a reviewer CLI with it would fail with `spawn <cli> ENOENT`.
      cwd: MISSING_REMOTE_WINDOWS_CWD,
      content: 'diff',
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'gemini',
      expect.any(String),
      process.cwd(),
      expect.any(AbortSignal),
    );
    expect(result.cwd).toBe(process.cwd());
    expect(result.reviewers).toEqual([{ provider: 'gemini', status: 'used' }]);
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
