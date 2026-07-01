import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { ReviewerPool } from './reviewer-pool';
import type { CliType } from '../cli/cli-detection';

type TestReviewService = CrossModelReviewService & {
  reviewerPool: ReviewerPool;
  parseReviewResponse: (reviewerId: string, rawResponse: string, reviewDepth: 'structured' | 'tiered', durationMs: number) => ReviewResult | null;
  collectSuccessfulReviews: (request: ReviewDispatchRequest, reviewerClis: string[], timeoutSeconds: number, signal: AbortSignal) => Promise<ReviewResult[]>;
  executeOneReview: (request: ReviewDispatchRequest, cliType: string, timeoutSeconds: number, signal: AbortSignal) => Promise<ReviewResult | null>;
  executeReviews: (request: ReviewDispatchRequest, reviewerClis: string[], timeoutSeconds: number) => Promise<void>;
  detectDisagreement: (reviews: ReviewResult[]) => boolean;
};

/** Long enough (>50 chars) and code-fenced so the classifier triggers a review. */
const REVIEWABLE_CONTENT = 'Here is the implementation:\n```ts\nconst x = 1;\nconst y = 2;\n```\nAll done.';

function makeInstanceManager(instance: Record<string, unknown> | undefined): { getInstance: () => unknown } {
  return { getInstance: () => instance };
}

function makeRequest(overrides: Partial<ReviewDispatchRequest> = {}): ReviewDispatchRequest {
  return {
    id: 'review-1',
    instanceId: 'inst-1',
    primaryProvider: 'claude',
    workingDirectory: '/tmp/review-context',
    content: '```ts\nconst x = 1;\n```',
    taskDescription: 'Implement the review service carefully.',
    classification: {
      type: 'code',
      shouldReview: true,
      isComplex: false,
      complexityReasons: [],
      codeLineCount: 1,
      fileCount: 1,
      stepCount: 0,
    },
    reviewDepth: 'structured',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    reviewerId: 'gemini',
    reviewType: 'structured',
    scores: {
      correctness: { reasoning: 'ok', score: 4, issues: [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: 'APPROVE',
    summary: 'Looks good',
    timestamp: Date.now(),
    durationMs: 42,
    parseSuccess: true,
    ...overrides,
  };
}

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn().mockResolvedValue('gemini'),
}));

vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(),
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

// Mutable holder so individual tests can configure the per-reviewer model
// override the service reads via resolveReviewerModelOverride(). Reset in
// beforeEach. vi.hoisted lets the (hoisted) vi.mock factory reference it.
const reviewTestState = vi.hoisted(() => ({
  modelByProvider: {} as Record<string, string>,
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
      crossModelReviewModelByProvider: reviewTestState.modelByProvider,
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
    reviewTestState.modelByProvider = {};
    vi.mocked(resolveCliType).mockImplementation(async (cli) => {
      if (!cli || cli === 'auto' || cli === 'openai') return 'codex';
      return cli as CliType;
    });
    vi.mocked(getProviderRuntimeService).mockReturnValue({
      createAdapter: vi.fn(),
      getCapabilities: vi.fn(),
      interruptTurn: vi.fn(),
      getResumeProof: vi.fn(),
    });
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

  it('treats low scores with an approve verdict as review concerns', () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const review = makeReview({
      overallVerdict: 'APPROVE',
      scores: {
        correctness: { reasoning: 'This misses the requested edge case', score: 2, issues: [] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
    });

    expect(service.detectDisagreement([review])).toBe(true);
  });

  it('does not treat clean approvals as review concerns', () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    expect(service.detectDisagreement([makeReview()])).toBe(false);
  });

  it('uses failover reviewers when an initially selected reviewer fails', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    service.reviewerPool.setAvailable(['gemini', 'codex', 'copilot']);

    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ cliType, options }) => ({
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

    const results = await service.collectSuccessfulReviews(makeRequest(), ['gemini', 'codex'], 30, new AbortController().signal);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.reviewerId)).toEqual(expect.arrayContaining(['codex', 'copilot']));
  });

  it('terminates one-shot reviewer adapters after successful reviews', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const terminate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => ({
      sendMessage: async () => ({
        content: JSON.stringify({
          correctness: { reasoning: 'ok', score: 4, issues: [] },
          completeness: { reasoning: 'ok', score: 4, issues: [] },
          security: { reasoning: 'ok', score: 4, issues: [] },
          consistency: { reasoning: 'ok', score: 4, issues: [] },
          overall_verdict: 'APPROVE',
          summary: 'approved',
        }),
      }),
      terminate,
    }));

    await expect(
      service.executeOneReview(makeRequest(), 'copilot', 30, new AbortController().signal)
    ).resolves.toMatchObject({ reviewerId: 'copilot' });

    expect(terminate).toHaveBeenCalledWith(false);
  });

  it('terminates one-shot reviewer adapters when reviews fail', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const terminate = vi.fn().mockResolvedValue(undefined);

    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => ({
      sendMessage: async () => {
        throw new Error('review failed');
      },
      terminate,
    }));

    await expect(
      service.executeOneReview(makeRequest(), 'copilot', 30, new AbortController().signal)
    ).rejects.toThrow('review failed');

    expect(terminate).toHaveBeenCalledWith(false);
  });

  it('passes a configured reviewer model override into the adapter options', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    reviewTestState.modelByProvider = { copilot: 'claude-sonnet-46' };

    let capturedModel: unknown = 'unset';
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ options }) => {
      capturedModel = options.model;
      return {
        sendMessage: async () => ({
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: 'approved',
          }),
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    await service.executeOneReview(makeRequest(), 'copilot', 30, new AbortController().signal);

    expect(capturedModel).toBe('claude-sonnet-46');
  });

  it('omits the model option when no override is set so the CLI auto-routes', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    // reviewTestState.modelByProvider stays {} (reset in beforeEach)

    let modelKeyPresent = true;
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ options }) => {
      modelKeyPresent = 'model' in options;
      return {
        sendMessage: async () => ({
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: 'approved',
          }),
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    await service.executeOneReview(makeRequest(), 'copilot', 30, new AbortController().signal);

    expect(modelKeyPresent).toBe(false);
  });

  it('runs codex at low reasoning effort and forces structured depth even for tiered requests', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    let capturedEffort: unknown = 'unset';
    let capturedPrompt = '';
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ options }) => {
      capturedEffort = (options as { reasoningEffort?: unknown }).reasoningEffort;
      return {
        sendMessage: async ({ content }: { content: string }) => {
          capturedPrompt = content;
          return {
            content: JSON.stringify({
              correctness: { reasoning: 'ok', score: 4, issues: [] },
              completeness: { reasoning: 'ok', score: 4, issues: [] },
              security: { reasoning: 'ok', score: 4, issues: [] },
              consistency: { reasoning: 'ok', score: 4, issues: [] },
              overall_verdict: 'APPROVE',
              summary: 'approved',
            }),
          };
        },
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    const result = await service.executeOneReview(
      makeRequest({ reviewDepth: 'tiered' }),
      'codex',
      30,
      new AbortController().signal,
    );

    expect(capturedEffort).toBe('low');
    // A structured prompt asks for the 4-dimension scoring schema, not tiered traces.
    expect(capturedPrompt).not.toContain('traces');
    expect(result?.reviewType).toBe('structured');
  });

  it('gives codex reviewers a longer process deadline than the global review timeout', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    let capturedTimeout: unknown = 0;
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ options }) => {
      capturedTimeout = options.timeout;
      return {
        sendMessage: async () => ({
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: 'approved',
          }),
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    await service.executeOneReview(makeRequest(), 'codex', 120, new AbortController().signal);

    expect(capturedTimeout).toBe(300_000);
  });

  it('keeps full tiered depth and default effort for non-codex reviewers', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    let effortKeyPresent = true;
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ options }) => {
      effortKeyPresent = 'reasoningEffort' in options;
      return {
        sendMessage: async () => ({
          content: JSON.stringify({
            scores: {
              correctness: { reasoning: 'ok', score: 4, issues: [] },
              completeness: { reasoning: 'ok', score: 4, issues: [] },
              security: { reasoning: 'ok', score: 4, issues: [] },
              consistency: { reasoning: 'ok', score: 4, issues: [] },
            },
            overall_verdict: 'APPROVE',
            summary: 'approved',
          }),
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    });

    const result = await service.executeOneReview(
      makeRequest({ reviewDepth: 'tiered' }),
      'copilot',
      30,
      new AbortController().signal,
    );

    expect(effortKeyPresent).toBe(false);
    expect(result?.reviewType).toBe('tiered');
  });

  describe('onInstanceIdle working-directory safety', () => {
    function makeWorkingAdapter(): { sendMessage: () => Promise<{ content: string }>; terminate: () => Promise<void> } {
      return {
        sendMessage: async () => ({
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: 'approved',
          }),
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('skips in-session reviews for remote instances and creates no adapter', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      service.setInstanceManager(makeInstanceManager({
        displayName: 'Remote instance',
        workingDirectory: 'C:\\Users\\shutu\\Documents\\Work',
        outputBuffer: [],
        executionLocation: { type: 'remote', nodeId: 'node-1' },
      }) as never);

      const started = vi.fn();
      const allUnavailable = vi.fn();
      service.on('review:started', started);
      service.on('review:all-unavailable', allUnavailable);
      service.bufferMessage('inst-remote', 'assistant', REVIEWABLE_CONTENT);

      await service.onInstanceIdle('inst-remote');

      expect(started).not.toHaveBeenCalled();
      expect(allUnavailable).not.toHaveBeenCalled();
      expect(getProviderRuntimeService().createAdapter).not.toHaveBeenCalled();
    });

    it('falls back to process.cwd() when the working directory does not exist locally', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => makeWorkingAdapter());
      service.setInstanceManager(makeInstanceManager({
        displayName: 'Local instance',
        workingDirectory: '/definitely/not/a/real/dir',
        outputBuffer: [],
        executionLocation: { type: 'local' },
      }) as never);

      const started = vi.fn();
      service.on('review:started', started);
      service.bufferMessage('inst-local-bad-dir', 'assistant', REVIEWABLE_CONTENT);

      await service.onInstanceIdle('inst-local-bad-dir');

      expect(started).toHaveBeenCalledTimes(1);
      const { reviewId } = started.mock.calls[0][0] as { reviewId: string };
      expect(service.getReviewContext(reviewId)?.workingDirectory).toBe(process.cwd());
    });

    it('treats a legacy instance without executionLocation as local and proceeds', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => makeWorkingAdapter());
      service.setInstanceManager(makeInstanceManager({
        displayName: 'Legacy instance',
        workingDirectory: process.cwd(),
        outputBuffer: [],
      }) as never);

      const started = vi.fn();
      service.on('review:started', started);
      service.bufferMessage('inst-legacy', 'assistant', REVIEWABLE_CONTENT);

      await service.onInstanceIdle('inst-legacy');

      expect(started).toHaveBeenCalledTimes(1);
      const { reviewId } = started.mock.calls[0][0] as { reviewId: string };
      expect(service.getReviewContext(reviewId)?.workingDirectory).toBe(process.cwd());
    });
  });

  it('emits all-unavailable when every reviewer response is unusable', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const allUnavailable = vi.fn();
    const result = vi.fn();
    service.on('review:all-unavailable', allUnavailable);
    service.on('review:result', result);

    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => ({
      sendMessage: async () => ({ content: 'not valid json' }),
    }));

    await service.executeReviews(makeRequest({
      id: 'review-2',
      instanceId: 'inst-2',
    }), ['gemini'], 30);

    expect(allUnavailable).toHaveBeenCalledWith({ instanceId: 'inst-2' });
    expect(result).not.toHaveBeenCalled();
  });
});
