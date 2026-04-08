import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { createCliAdapter, resolveCliType } from '../cli/adapters/adapter-factory';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { ReviewerPool } from './reviewer-pool';
import type { CliType } from '../cli/cli-detection';

type TestReviewService = CrossModelReviewService & {
  reviewerPool: ReviewerPool;
  parseReviewResponse: (reviewerId: string, rawResponse: string, reviewDepth: 'structured' | 'tiered', durationMs: number) => ReviewResult | null;
  collectSuccessfulReviews: (request: ReviewDispatchRequest, reviewerClis: string[], timeoutSeconds: number, signal: AbortSignal) => Promise<ReviewResult[]>;
  executeReviews: (request: ReviewDispatchRequest, reviewerClis: string[], timeoutSeconds: number) => Promise<void>;
};

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(),
  resolveCliType: vi.fn().mockResolvedValue('gemini'),
}));

vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: vi.fn().mockResolvedValue({
        available: [{ name: 'gemini' }, { name: 'codex' }, { name: 'copilot' }],
      }),
    }),
  },
}));

vi.mock('../instance/instance-manager', () => ({
  getInstanceManager: () => ({
    getInstance: () => ({
      displayName: 'Test instance',
      workingDirectory: '/tmp/review-context',
      outputBuffer: [{ type: 'user', content: 'Implement the review service carefully.' }],
    }),
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

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: () => ({
    getBreaker: () => ({
      execute: async <T>(fn: () => Promise<T>) => fn(),
    }),
  }),
}));

describe('CrossModelReviewService', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
    vi.mocked(resolveCliType).mockImplementation(async (cli) => {
      if (!cli || cli === 'auto' || cli === 'openai') return 'codex';
      return cli as CliType;
    });
    vi.mocked(createCliAdapter).mockReset();
  });

  it('creates singleton instance', () => {
    const a = CrossModelReviewService.getInstance();
    const b = CrossModelReviewService.getInstance();
    expect(a).toBe(b);
  });

  it('buffers assistant messages per instance', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Here is code:\n```ts\nconst x = 1;\n```');
    service.bufferMessage('inst-1', 'user', 'Thanks');
    service.bufferMessage('inst-2', 'assistant', 'Different instance');

    expect(service.getBufferSize('inst-1')).toBe(1);
    expect(service.getBufferSize('inst-2')).toBe(1);
  });

  it('ignores non-assistant messages', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'user', 'Hello');
    service.bufferMessage('inst-1', 'system', 'System msg');
    service.bufferMessage('inst-1', 'tool_use', 'Tool call');
    expect(service.getBufferSize('inst-1')).toBe(0);
  });

  it('clears buffer on instance removal', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Some output');
    service.clearBuffer('inst-1');
    expect(service.getBufferSize('inst-1')).toBe(0);
  });

  it('stores and retrieves review history', () => {
    const service = CrossModelReviewService.getInstance();
    expect(service.getReviewHistory('inst-1')).toEqual([]);
  });

  it('returns status', () => {
    const service = CrossModelReviewService.getInstance();
    const status = service.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.pendingReviews).toBe(0);
  });

  it('skips unparsable reviewer responses instead of surfacing concerns', () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    expect(service.parseReviewResponse('gemini', 'not valid json', 'structured', 42)).toBeNull();
  });

  it('uses failover reviewers when an initially selected reviewer fails', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    service.reviewerPool.setAvailable(['gemini', 'codex', 'copilot']);

    vi.mocked(createCliAdapter).mockImplementation((cliType, options) => ({
      sendMessage: async ({ content }: { content: string }) => {
        expect(options.workingDirectory).toBe('/tmp/review-context');
        expect(content).toContain('Implement the review service carefully.');
        if (cliType === 'gemini') {
          throw new Error('rate limit');
        }
        return {
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: `${cliType} approved`,
          }),
        };
      },
    }));

    const results = await service.collectSuccessfulReviews({
      id: 'review-1',
      instanceId: 'inst-1',
      primaryProvider: 'claude',
      workingDirectory: '/tmp/review-context',
      content: '```ts\nconst x = 1;\n```',
      taskDescription: 'Implement the review service carefully.',
      classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 },
      reviewDepth: 'structured',
      timestamp: Date.now(),
    }, ['gemini', 'codex'], 30, new AbortController().signal);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.reviewerId)).toEqual(expect.arrayContaining(['codex', 'copilot']));
  });

  it('emits all-unavailable when every reviewer response is unusable', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const allUnavailable = vi.fn();
    const result = vi.fn();
    service.on('review:all-unavailable', allUnavailable);
    service.on('review:result', result);

    vi.mocked(createCliAdapter).mockImplementation(() => ({
      sendMessage: async () => ({ content: 'not valid json' }),
    }));

    await service.executeReviews({
      id: 'review-2',
      instanceId: 'inst-2',
      primaryProvider: 'claude',
      workingDirectory: '/tmp/review-context',
      content: '```ts\nconst x = 1;\n```',
      taskDescription: 'Implement the review service carefully.',
      classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 },
      reviewDepth: 'structured',
      timestamp: Date.now(),
    }, ['gemini'], 30);

    expect(allUnavailable).toHaveBeenCalledWith({ instanceId: 'inst-2' });
    expect(result).not.toHaveBeenCalled();
  });
});
