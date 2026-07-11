import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isBlockingFreshEyesFinding,
  runLocalOnlyFreshEyesReview,
  type FreshEyesReviewerInput,
} from './loop-fresh-eyes-reviewer';

const runHeadlessReview = vi.hoisted(() => vi.fn());
const localReviewService = { runHeadlessReview };

function localInput(): FreshEyesReviewerInput {
  return {
    loopRunId: 'loop-1',
    workspaceCwd: '/repo',
    goal: 'finish the widget',
    iterationOutput: 'done',
    diff: 'diff --git a/src/a.ts b/src/a.ts',
    diffSource: 'git',
    filesChangedThisIteration: ['src/a.ts'],
    uncompletedPlanFilesAtStart: [],
    verifyOutputExcerpt: 'tests passed',
    signal: 'ping-pong',
    config: {
      enabled: true,
      blockingSeverities: ['critical', 'high'],
      timeoutSeconds: 90,
      reviewDepth: 'structured',
    },
  };
}

beforeEach(() => runHeadlessReview.mockReset());

describe('isBlockingFreshEyesFinding', () => {
  const finding = {
    title: 'Concern',
    body: 'Details',
    severity: 'high' as const,
    confidence: 0.9,
  };

  it('keeps a remotely authoritative configured severity blocking', () => {
    expect(isBlockingFreshEyesFinding(finding, ['critical', 'high'])).toBe(true);
  });

  it('never lets a local-only advisory finding block completion', () => {
    expect(isBlockingFreshEyesFinding({ ...finding, advisory: true }, ['critical', 'high']))
      .toBe(false);
  });
});

describe('runLocalOnlyFreshEyesReview', () => {
  it('uses the configured local participant without launching any remote reviewer', async () => {
    runHeadlessReview.mockResolvedValue({
      reviewers: [{ provider: 'local-model', source: 'local', status: 'used' }],
      findings: [{
        title: 'Local concern', body: 'Check this path.', severity: 'high', confidence: 0.8,
      }],
      summary: 'One finding.',
      infrastructureErrors: ['No remote reviewers completed.'],
    });

    await expect(runLocalOnlyFreshEyesReview(localInput(), localReviewService)).resolves.toEqual({
      status: 'used',
      findings: [expect.objectContaining({ title: 'Local concern', advisory: true })],
      summary: 'One finding.',
    });
    expect(runHeadlessReview).toHaveBeenCalledWith(expect.objectContaining({ reviewers: [] }));
  });

  it('forwards the isolated checkout and external cancellation signal to headless local review', async () => {
    const abort = new AbortController();
    runHeadlessReview.mockResolvedValue({ reviewers: [], findings: [], summary: '', infrastructureErrors: [] });

    await runLocalOnlyFreshEyesReview({
      ...localInput(),
      workspaceCwd: '/repo/.worktrees/isolated',
      abortSignal: abort.signal,
    }, localReviewService);

    expect(runHeadlessReview).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo/.worktrees/isolated',
      signal: abort.signal,
      reviewers: [],
    }));
  });

  it('reports an unavailable configured local participant as skipped', async () => {
    runHeadlessReview.mockResolvedValue({
      reviewers: [{
        provider: 'local-model', source: 'local', status: 'skipped', reason: 'No model selected.',
      }],
      findings: [],
      summary: 'No reviewers.',
      infrastructureErrors: [],
    });

    await expect(runLocalOnlyFreshEyesReview(localInput(), localReviewService)).resolves.toMatchObject({
      status: 'skipped', reason: 'No model selected.', findings: [],
    });
  });

  it('reports a local participant failure without treating the empty remote list as authoritative', async () => {
    runHeadlessReview.mockResolvedValue({
      reviewers: [{
        provider: 'local-model', source: 'local', status: 'failed', reason: 'Local timeout.',
      }],
      findings: [],
      summary: 'No remote reviewers completed.',
      infrastructureErrors: ['No remote reviewers completed.'],
    });

    await expect(runLocalOnlyFreshEyesReview(localInput(), localReviewService)).resolves.toMatchObject({
      status: 'failed', reason: 'Local timeout.', findings: [],
    });
  });
});
