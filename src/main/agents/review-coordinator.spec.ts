import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewAgentConfig } from '../../shared/types/review-agent.types';
import { ReviewCoordinator } from './review-coordinator';

const agent: ReviewAgentConfig = {
  id: 'strict-reviewer',
  name: 'Strict reviewer',
  description: 'Test reviewer',
  icon: 'search',
  color: '#000000',
  focusAreas: ['correctness'],
  scoringSystem: { type: 'confidence', min: 0, max: 100, threshold: 80 },
  systemPromptAddition: '',
};

const validFinding = JSON.stringify({
  issues: [{
    file: 'src/example.ts',
    line: 12,
    category: 'correctness',
    severity: 'high',
    confidence: 90,
    title: 'Incorrect fallback',
    description: 'The fallback returns the wrong state.',
  }],
});

describe('ReviewCoordinator response contracts', () => {
  let coordinator: ReviewCoordinator;

  beforeEach(() => {
    ReviewCoordinator._resetForTesting();
    coordinator = ReviewCoordinator.getInstance();
  });

  afterEach(() => {
    ReviewCoordinator._resetForTesting();
  });

  it('repairs one malformed response before accepting findings', async () => {
    const responses = ['I found something but forgot the contract.', validFinding];
    const invocations = vi.fn((payload: { callback: (error: string | null, response: string, tokens: number) => void }) => {
      payload.callback(null, responses.shift() ?? '', 5);
    });
    coordinator.on('review:invoke-agent', invocations);
    const completed = new Promise<{ reviewId: string }>((resolve) => coordinator.once('review:completed', resolve));

    const reviewId = await coordinator.startReview([], [agent], { parallel: false });
    await completed;

    expect(invocations).toHaveBeenCalledTimes(2);
    expect(coordinator.getIssues(reviewId)).toEqual([
      expect.objectContaining({ title: 'Incorrect fallback', file: 'src/example.ts', line: 12 }),
    ]);
  });

  it('fails closed when both the original response and repair are malformed', async () => {
    coordinator.on('review:invoke-agent', (payload: { callback: (error: string | null, response: string, tokens: number) => void }) => {
      payload.callback(null, 'still not JSON', 1);
    });
    const failed = new Promise<{ reviewId: string; error: string }>((resolve) => coordinator.once('review:failed', resolve));

    const reviewId = await coordinator.startReview([], [agent], { parallel: false });
    const failure = await failed;

    expect(failure.reviewId).toBe(reviewId);
    expect(failure.error).toContain('valid review JSON');
    expect(coordinator.getReview(reviewId)?.status).toBe('failed');
  });

  it('enforces each agent scoring threshold in code', async () => {
    const belowThreshold = validFinding.replace('"confidence":90', '"confidence":79');
    coordinator.on('review:invoke-agent', (payload: { callback: (error: string | null, response: string, tokens: number) => void }) => {
      payload.callback(null, belowThreshold, 1);
    });
    const completed = new Promise<{ reviewId: string }>((resolve) => coordinator.once('review:completed', resolve));

    const reviewId = await coordinator.startReview([], [agent], { parallel: false });
    await completed;

    expect(coordinator.getIssues(reviewId)).toEqual([]);
  });
});
