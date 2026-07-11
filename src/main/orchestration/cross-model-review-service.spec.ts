import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import type { AggregatedReview, ReviewResult } from '../../shared/types/cross-model-review.types';
import type { ReviewerPool } from './reviewer-pool';
import type { CliType } from '../cli/cli-detection';
import { normalizeReviewerCliList } from './cross-model-review-service.constants';

type TestReviewService = CrossModelReviewService & {
  reviewerPool: ReviewerPool;
  refreshAvailability: () => Promise<void>;
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

const detectionTestState = vi.hoisted(() => ({
  availableClis: ['gemini', 'codex', 'copilot'] as string[],
}));

vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: vi.fn().mockResolvedValue({
        available: detectionTestState.availableClis.map((name) => ({ name })),
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
  providers: [] as string[],
  maxReviewers: 2,
  localEnabled: false,
  localSelectorId: '',
  localTimeout: 120,
  localMaxToolRounds: 12,
  qualityModel: '',
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewEnabled: true,
      crossModelReviewDepth: 'structured',
      crossModelReviewMaxReviewers: reviewTestState.maxReviewers,
      crossModelReviewProviders: reviewTestState.providers,
      crossModelReviewTimeout: 30,
      crossModelReviewTypes: ['code', 'plan', 'architecture'],
      crossModelReviewModelByProvider: reviewTestState.modelByProvider,
      crossModelReviewLocalEnabled: reviewTestState.localEnabled,
      crossModelReviewLocalSelectorId: reviewTestState.localSelectorId,
      crossModelReviewLocalTimeout: reviewTestState.localTimeout,
      crossModelReviewLocalMaxToolRounds: reviewTestState.localMaxToolRounds,
      auxiliaryLlmQualityModel: reviewTestState.qualityModel,
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
    reviewTestState.providers = [];
    reviewTestState.maxReviewers = 2;
    reviewTestState.localEnabled = false;
    reviewTestState.localSelectorId = '';
    reviewTestState.qualityModel = '';
    detectionTestState.availableClis = ['gemini', 'codex', 'copilot'];
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

  it('normalizes every supported remote reviewer and the legacy Gemini alias', () => {
    expect(normalizeReviewerCliList(['claude', 'grok', 'gemini'])).toEqual([
      'claude', 'grok', 'antigravity',
    ]);
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

  it('warns and emits review:reviewer-unavailable when a configured reviewer is not detected', async () => {
    // antigravity is configured #1 but not detected; cursor/copilot are.
    detectionTestState.availableClis = ['cursor', 'copilot'];
    reviewTestState.providers = ['antigravity', 'cursor', 'copilot'];

    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    const unavailable = new Promise<{ dropped: { cli: string; error: string }[] }>((resolve) => {
      service.once('review:reviewer-unavailable', resolve as never);
    });

    await service.refreshAvailability();
    const payload = await unavailable;

    expect(payload.dropped.map((d) => d.cli)).toContain('antigravity');
  });

  it('does not re-emit review:reviewer-unavailable while the dropped set is unchanged', async () => {
    detectionTestState.availableClis = ['cursor', 'copilot'];
    reviewTestState.providers = ['antigravity', 'cursor', 'copilot'];

    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    let emits = 0;
    service.on('review:reviewer-unavailable', () => { emits += 1; });

    await service.refreshAvailability();
    await service.refreshAvailability();

    expect(emits).toBe(1);
  });

  it('emits review:reviewer-rate-limited when a reviewer hits a usage cap', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(() => ({
      sendMessage: async () => {
        throw new Error('Grok Build: usage limit reached for your subscription');
      },
      terminate: vi.fn().mockResolvedValue(undefined),
    }));

    const events: { cliType: string }[] = [];
    service.on('review:reviewer-rate-limited', (e) => events.push(e as { cliType: string }));

    const signal = new AbortController().signal;
    await expect(service.executeOneReview(makeRequest(), 'copilot', 30, signal)).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]?.cliType).toBe('copilot');
  });

  it('uses Antigravity when a legacy Gemini reviewer is configured and agy is detected', async () => {
    detectionTestState.availableClis = ['antigravity', 'codex'];
    reviewTestState.providers = ['gemini', 'codex'];
    reviewTestState.maxReviewers = 1;
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    service.setInstanceManager(makeInstanceManager({
      displayName: 'Local instance',
      workingDirectory: process.cwd(),
      outputBuffer: [{ type: 'user', content: 'Implement the review service carefully.' }],
      executionLocation: { type: 'local' },
    }) as never);

    const adapterCliTypes: string[] = [];
    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ cliType }) => {
      adapterCliTypes.push(cliType);
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

    const reviewResult = new Promise((resolve) => service.once('review:result', resolve));
    service.bufferMessage('inst-legacy-gemini-reviewer', 'assistant', REVIEWABLE_CONTENT);

    await service.onInstanceIdle('inst-legacy-gemini-reviewer');
    await reviewResult;

    expect(adapterCliTypes).toEqual(['antigravity']);
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
    service.reviewerPool.setAvailable(['antigravity', 'codex', 'copilot']);

    vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(({ cliType, options }) => ({
      sendMessage: async ({ content }: { content: string }) => {
        expect(options.workingDirectory).toBe('/tmp/review-context');
        expect(content).toContain('Implement the review service carefully.');
        if (cliType === 'antigravity') {
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

    const results = await service.collectSuccessfulReviews(makeRequest(), ['antigravity', 'codex'], 30, new AbortController().signal);

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

  it('runs a local concern when zero remote reviewers are available without giving it blocking authority', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    reviewTestState.localEnabled = true;
    reviewTestState.localSelectorId = '';
    reviewTestState.qualityModel = 'qwen';
    const localReview = makeReview({
      reviewerId: 'local:qwen',
      source: 'local',
      overallVerdict: 'REJECT',
      criticalIssues: ['Local concern'],
    });
    service.setLocalReviewDependenciesForTesting(
      { review: vi.fn().mockResolvedValue({ status: 'used', review: localReview, evidencePaths: ['src/a.ts'] }) },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );
    const result = new Promise<AggregatedReview>((resolve) => {
      service.once('review:result', resolve as never);
    });

    await service.executeReviews(makeRequest(), [], 30);

    await expect(result).resolves.toMatchObject({
      reviews: [{ reviewerId: 'local:qwen', source: 'local' }],
      localReviewer: { status: 'used', selectorId, model: 'qwen' },
      hasDisagreement: false,
    });
  });

  it('skips the same local selector as the builder while preserving a remote success', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    reviewTestState.localEnabled = true;
    reviewTestState.localSelectorId = selectorId;
    const localReviewer = { review: vi.fn() };
    service.setLocalReviewDependenciesForTesting(localReviewer, { list: () => [{
      selectorId,
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      displayName: 'Qwen',
      healthy: true,
      loaded: true,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
      discoveredAt: 1,
    }] });
    vi.spyOn(service, 'collectSuccessfulReviews').mockResolvedValue([makeReview({ reviewerId: 'codex' })]);
    const result = new Promise<AggregatedReview>((resolve) => {
      service.once('review:result', resolve as never);
    });

    await service.executeReviews(makeRequest({
      builderModelRuntimeTarget: {
        kind: 'local-model',
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    }), ['codex'], 30);

    expect(localReviewer.review).not.toHaveBeenCalled();
    await expect(result).resolves.toMatchObject({
      reviews: [{ reviewerId: 'codex' }],
      localReviewer: { status: 'skipped', reason: expect.stringContaining('builder') },
    });
  });
});
