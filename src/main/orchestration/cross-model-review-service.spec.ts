import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import {
  getProviderRuntimeService,
  type ProviderRuntimeService,
  type ProviderRuntimeStartInput,
} from '../providers/provider-runtime-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import type { AggregatedReview, ReviewResult } from '../../shared/types/cross-model-review.types';
import type { ReviewerPool } from './reviewer-pool';
import type { CliType } from '../cli/cli-detection';
import { normalizeReviewerCliList } from './cross-model-review-service.constants';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

/**
 * `CliAdapter` is a large union of concrete adapter classes, and
 * `ProviderRuntimeService.createAdapter` is typed to return it. These tests
 * only stub the handful of members (`sendMessage`, `terminate`, `interrupt`)
 * that `executeOneReview` actually calls, so the fakes are intentionally
 * partial test doubles — route every `createAdapter` mock through these two
 * helpers instead of casting at each call site.
 */
function mockCreateAdapter(impl: (input: ProviderRuntimeStartInput) => object): void {
  vi.mocked(getProviderRuntimeService().createAdapter).mockImplementation(
    impl as unknown as (input: ProviderRuntimeStartInput) => CliAdapter,
  );
}

function mockCreateAdapterReturnValue(value: object): void {
  vi.mocked(getProviderRuntimeService().createAdapter).mockReturnValue(value as unknown as CliAdapter);
}

// `CrossModelReviewService` declares these members `private`; intersecting the
// class type directly with an object type re-declaring the same names as
// public collapses the whole intersection to `never` (private members are
// nominally branded, so TS can't reconcile them with a public re-declaration
// even when the value types match). `Omit` first to drop the private
// declarations, then add the public test-only view of them.
type PrivateReviewMembers =
  | 'reviewerPool'
  | 'refreshAvailability'
  | 'parseReviewResponse'
  | 'collectSuccessfulReviews'
  | 'executeOneReview'
  | 'executeReviews'
  | 'detectDisagreement';

type TestReviewService = Omit<CrossModelReviewService, PrivateReviewMembers> & {
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
  quotaSnapshot: null as ProviderQuotaSnapshot | null,
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

vi.mock('../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => ({
    getSnapshot: () => reviewTestState.quotaSnapshot,
  }),
}));

function makeAntigravityQuotaSnapshot(
  geminiUsed: number,
  thirdPartyUsed = 0,
  takenAt = Date.now(),
): ProviderQuotaSnapshot {
  return {
    provider: 'antigravity',
    takenAt,
    source: 'admin-api',
    ok: true,
    windows: [
      {
        kind: 'rolling-window',
        id: 'antigravity.gemini-5h',
        label: 'Gemini · 5-hour',
        unit: 'requests',
        used: geminiUsed,
        limit: 100,
        remaining: 100 - geminiUsed,
        resetsAt: null,
      },
      {
        kind: 'rolling-window',
        id: 'antigravity.gemini-weekly',
        label: 'Gemini · weekly',
        unit: 'requests',
        used: geminiUsed,
        limit: 100,
        remaining: 100 - geminiUsed,
        resetsAt: null,
      },
      {
        kind: 'rolling-window',
        id: 'antigravity.3p-5h',
        label: 'Claude/GPT · 5-hour',
        unit: 'requests',
        used: thirdPartyUsed,
        limit: 100,
        remaining: 100 - thirdPartyUsed,
        resetsAt: null,
      },
    ],
  };
}

describe('CrossModelReviewService', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
    reviewTestState.modelByProvider = {};
    reviewTestState.providers = [];
    reviewTestState.maxReviewers = 2;
    reviewTestState.localEnabled = false;
    reviewTestState.localSelectorId = '';
    reviewTestState.qualityModel = '';
    reviewTestState.quotaSnapshot = null;
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
    } as unknown as ProviderRuntimeService);
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

  it('replaces streaming snapshots for the same message instead of token-echoing prefixes', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const instance = {
      displayName: 'Review streaming output',
      workingDirectory: process.cwd(),
      outputBuffer: [
        { id: 'user-old', timestamp: 1, type: 'user', content: 'Old unrelated task' },
        { id: 'user-current', timestamp: 2, type: 'user', content: 'Review the current implementation' },
      ],
      executionLocation: { type: 'local' },
    };
    service.setInstanceManager(makeInstanceManager(instance) as never);

    let reviewerPrompt = '';
    mockCreateAdapter(() => ({
      sendMessage: async ({ content }: { content: string }) => {
        reviewerPrompt = content;
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
    }));

    const firstSnapshot = REVIEWABLE_CONTENT.slice(0, 52);
    service.bufferMessage('inst-stream', 'assistant', firstSnapshot, 'codex', '', 'assistant-1', firstSnapshot);
    service.bufferMessage('inst-stream', 'assistant', REVIEWABLE_CONTENT.slice(52), 'codex', '', 'assistant-1', REVIEWABLE_CONTENT);
    expect(service.getBufferSize('inst-stream')).toBe(1);

    const result = new Promise((resolve) => service.once('review:result', resolve));
    await service.onInstanceIdle('inst-stream');
    await result;

    expect(reviewerPrompt).toContain(REVIEWABLE_CONTENT);
    expect(reviewerPrompt).toContain('Review the current implementation');
    expect(reviewerPrompt).not.toContain('Old unrelated task');
    expect(reviewerPrompt.indexOf(firstSnapshot)).toBe(reviewerPrompt.lastIndexOf(firstSnapshot));
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
    mockCreateAdapter(() => ({
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
    mockCreateAdapter(({ cliType }) => {
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

    mockCreateAdapter(({ cliType, options }) => ({
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

    mockCreateAdapter(() => ({
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

    mockCreateAdapter(() => ({
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

  it('interrupts and force-terminates an in-session reviewer when its signal is cancelled', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const abort = new AbortController();
    let rejectSend!: (reason?: unknown) => void;
    const sendMessage = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const interrupt = vi.fn(() => ({ status: 'accepted' as const }));
    const terminate = vi.fn(async () => undefined);
    mockCreateAdapterReturnValue({
      sendMessage, interrupt, terminate,
    });

    const pending = service.executeOneReview(makeRequest(), 'copilot', 30, abort.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    abort.abort();

    await expect(Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ])).rejects.toThrow('Review cancelled');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(false);

    rejectSend(new Error('late adapter rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('passes a configured reviewer model override into the adapter options', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    reviewTestState.modelByProvider = { copilot: 'claude-sonnet-46' };

    let capturedModel: unknown = 'unset';
    mockCreateAdapter(({ options }) => {
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
    mockCreateAdapter(({ options }) => {
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

  describe('Antigravity quota-aware reviewer model routing', () => {
    const GEMINI_MODEL = 'Gemini 3.5 Flash (Medium)';
    const SONNET_MODEL = 'Claude Sonnet 4.6 (Thinking)';
    const GPT_OSS_MODEL = 'GPT-OSS 120B (Medium)';
    const validReview = JSON.stringify({
      correctness: { reasoning: 'ok', score: 4, issues: [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
      overall_verdict: 'APPROVE',
      summary: 'approved',
    });

    it('keeps the configured Gemini model while its quota windows have capacity', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      reviewTestState.modelByProvider = { antigravity: GEMINI_MODEL };
      reviewTestState.quotaSnapshot = makeAntigravityQuotaSnapshot(99);
      const models: unknown[] = [];
      mockCreateAdapter(({ options }) => {
        models.push(options.model);
        return {
          sendMessage: async () => ({ content: validReview }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      });

      await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(models).toEqual([GEMINI_MODEL]);
    });

    it('routes an exhausted Gemini reviewer to Sonnet', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      reviewTestState.modelByProvider = { antigravity: GEMINI_MODEL };
      reviewTestState.quotaSnapshot = makeAntigravityQuotaSnapshot(100);
      const models: unknown[] = [];
      mockCreateAdapter(({ options }) => {
        models.push(options.model);
        return {
          sendMessage: async () => ({ content: validReview }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      });

      await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(models).toEqual([SONNET_MODEL]);
    });

    it('keeps Gemini when the quota snapshot is stale instead of guessing', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      reviewTestState.modelByProvider = { antigravity: GEMINI_MODEL };
      reviewTestState.quotaSnapshot = makeAntigravityQuotaSnapshot(100, 0, Date.now() - 20 * 60_000);
      const models: unknown[] = [];
      mockCreateAdapter(({ options }) => {
        models.push(options.model);
        return {
          sendMessage: async () => ({ content: validReview }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      });

      await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(models).toEqual([GEMINI_MODEL]);
    });

    it('falls back from malformed Sonnet output to GPT-OSS under the same review operation', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      reviewTestState.modelByProvider = { antigravity: GEMINI_MODEL };
      reviewTestState.quotaSnapshot = makeAntigravityQuotaSnapshot(100);
      const models: unknown[] = [];
      mockCreateAdapter(({ options }) => {
        models.push(options.model);
        return {
          sendMessage: options.model === SONNET_MODEL
            ? vi.fn().mockResolvedValue({ content: 'not valid json' })
            : vi.fn().mockResolvedValue({ content: validReview }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      });

      const result = await service.executeOneReview(
        makeRequest(),
        'antigravity',
        30,
        new AbortController().signal,
      );

      expect(models).toEqual([SONNET_MODEL, GPT_OSS_MODEL]);
      expect(result).toMatchObject({ reviewerId: 'antigravity', parseSuccess: true });
    });

    it('does not try GPT-OSS after Sonnet reports exhaustion of their shared quota pool', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      reviewTestState.modelByProvider = { antigravity: GEMINI_MODEL };
      reviewTestState.quotaSnapshot = makeAntigravityQuotaSnapshot(100);
      const models: unknown[] = [];
      mockCreateAdapter(({ options }) => {
        models.push(options.model);
        return {
          sendMessage: async () => { throw new Error('Claude/GPT quota exceeded'); },
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      });

      await expect(service.executeOneReview(
        makeRequest(),
        'antigravity',
        30,
        new AbortController().signal,
      )).rejects.toThrow('quota exceeded');

      expect(models).toEqual([SONNET_MODEL]);
    });
  });

  it('runs codex at low reasoning effort and forces structured depth even for tiered requests', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    let capturedEffort: unknown = 'unset';
    let capturedPrompt = '';
    mockCreateAdapter(({ options }) => {
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
    mockCreateAdapter(({ options }) => {
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

  describe('reviewer timeout floor', () => {
    async function timeoutFor(cliType: string, timeoutSeconds: number): Promise<number> {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      let capturedTimeout = 0;
      mockCreateAdapter(({ options }) => {
        capturedTimeout = options.timeout ?? 0;
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
      await service.executeOneReview(makeRequest(), cliType, timeoutSeconds, new AbortController().signal);
      return capturedTimeout;
    }

    it.each([
      ['antigravity', 120, 300_000],
      ['antigravity', 420, 420_000],
      ['codex', 120, 300_000],
      ['copilot', 120, 120_000],
    ] as const)('resolves the effective timeout for %s at %dsec configured to %dms', async (cliType, seconds, expected) => {
      await expect(timeoutFor(cliType, seconds)).resolves.toBe(expected);
    });
  });

  it('keeps full tiered depth and default effort for non-codex reviewers', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;

    let effortKeyPresent = true;
    mockCreateAdapter(({ options }) => {
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

  describe('format-repair retry and shared operation deadline', () => {
    it('retries once with a format-repair prompt and accepts a valid repaired response', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      const sendMessage = vi.fn()
        .mockResolvedValueOnce({ content: 'not valid json' })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
            overall_verdict: 'APPROVE',
            summary: 'approved after reformat',
          }),
        });
      mockCreateAdapter(() => ({
        sendMessage,
        terminate: vi.fn().mockResolvedValue(undefined),
      }));

      const result = await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[1]?.[0].content).toContain('reformat');
      expect(result).toMatchObject({ reviewerId: 'antigravity', parseSuccess: true });
    });

    it('returns null when both the initial and the repaired responses fail validation', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      const sendMessage = vi.fn().mockResolvedValue({ content: 'still not valid json' });
      mockCreateAdapter(() => ({
        sendMessage,
        terminate: vi.fn().mockResolvedValue(undefined),
      }));

      const result = await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(result).toBeNull();
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('does not attempt a repair when the reviewer plainly refuses', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      const sendMessage = vi.fn().mockResolvedValue({ content: 'I cannot fulfill this request.' });
      mockCreateAdapter(() => ({
        sendMessage,
        terminate: vi.fn().mockResolvedValue(undefined),
      }));

      const result = await service.executeOneReview(makeRequest(), 'antigravity', 30, new AbortController().signal);

      expect(result).toBeNull();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('force-terminates the adapter via a single operation deadline when the reviewer hangs', async () => {
      vi.useFakeTimers();
      try {
        const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
        const interrupt = vi.fn(() => ({ status: 'accepted' as const }));
        const terminate = vi.fn(async () => undefined);
        const sendMessage = vi.fn(() => new Promise<never>(() => {}));
        mockCreateAdapterReturnValue({ sendMessage, interrupt, terminate });

        const pending = service.executeOneReview(makeRequest(), 'copilot', 5, new AbortController().signal);
        const assertion = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;

        expect(interrupt).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledWith(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shares one deadline across the initial and repair sends instead of resetting it', async () => {
      vi.useFakeTimers();
      try {
        const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
        const interrupt = vi.fn(() => ({ status: 'accepted' as const }));
        const terminate = vi.fn(async () => undefined);
        const sendMessage = vi.fn()
          .mockResolvedValueOnce({ content: 'not valid json' })
          .mockImplementationOnce(() => new Promise<never>(() => {}));
        mockCreateAdapterReturnValue({ sendMessage, interrupt, terminate });

        const pending = service.executeOneReview(makeRequest(), 'copilot', 5, new AbortController().signal);
        const assertion = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;

        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(interrupt).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still reports "Review cancelled" immediately for an upstream abort, not a deadline error', async () => {
      const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
      const abort = new AbortController();
      const sendMessage = vi.fn(() => new Promise<never>(() => {}));
      const interrupt = vi.fn(() => ({ status: 'accepted' as const }));
      const terminate = vi.fn(async () => undefined);
      mockCreateAdapterReturnValue({ sendMessage, interrupt, terminate });

      const pending = service.executeOneReview(makeRequest(), 'copilot', 300, abort.signal);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      abort.abort();

      await expect(pending).rejects.toThrow('Review cancelled');
    });
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
      mockCreateAdapter(() => makeWorkingAdapter());
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
      mockCreateAdapter(() => makeWorkingAdapter());
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

    mockCreateAdapter(() => ({
      sendMessage: async () => ({ content: 'not valid json' }),
    }));

    await service.executeReviews(makeRequest({
      id: 'review-2',
      instanceId: 'inst-2',
      timestamp: 123,
    }), ['gemini'], 30);

    expect(allUnavailable).toHaveBeenCalledWith({
      instanceId: 'inst-2',
      reviewId: 'review-2',
      reviewStartedAt: 123,
    });
    expect(result).not.toHaveBeenCalled();
  });

  it('discards a completed review when a newer user turn supersedes its source turn', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    const instance = {
      outputBuffer: [
        { id: 'user-1', timestamp: 1, type: 'user', content: 'Original task' },
      ],
    };
    service.setInstanceManager(makeInstanceManager(instance) as never);
    vi.spyOn(service, 'collectSuccessfulReviews').mockImplementation(async () => {
      instance.outputBuffer.push({
        id: 'user-2',
        timestamp: 2,
        type: 'user',
        content: 'Newer task',
      });
      return [makeReview()];
    });
    const result = vi.fn();
    const allUnavailable = vi.fn();
    const discarded = vi.fn();
    service.on('review:result', result);
    service.on('review:all-unavailable', allUnavailable);
    service.on('review:discarded', discarded);

    await service.executeReviews(makeRequest({
      sourceUserMessageId: 'user-1',
      sourceUserMessageTimestamp: 1,
      timestamp: 123,
    }), ['gemini'], 30);

    expect(result).not.toHaveBeenCalled();
    expect(allUnavailable).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      reviewId: 'review-1',
      reviewStartedAt: 123,
      reason: 'superseded',
    });
    expect(service.getReviewHistory('inst-1')).toEqual([]);
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

    await service.executeReviews(makeRequest({ timestamp: 123 }), [], 30);

    await expect(result).resolves.toMatchObject({
      reviews: [{ reviewerId: 'local:qwen', source: 'local' }],
      localReviewer: { status: 'used', selectorId, model: 'qwen' },
      hasDisagreement: false,
    });
  });

  it('emits a visible empty result when the local reviewer failed and no remote reviewer succeeds', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    reviewTestState.localEnabled = true;
    reviewTestState.localSelectorId = 'lm://this-device/ollama/ollama/qwen';
    const localReviewer = { review: vi.fn().mockResolvedValue({ status: 'failed', reason: 'endpoint stopped' }) };
    service.setLocalReviewDependenciesForTesting(localReviewer, { list: () => [{
      selectorId: reviewTestState.localSelectorId,
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
    const allUnavailable = vi.fn();
    service.on('review:all-unavailable', allUnavailable);
    const result = new Promise<AggregatedReview>((resolve) => service.once('review:result', resolve as never));

    await service.executeReviews(makeRequest(), [], 30);

    await expect(result).resolves.toMatchObject({
      reviews: [],
      localReviewer: { status: 'failed', reason: expect.stringContaining('endpoint stopped') },
      hasDisagreement: false,
    });
    expect(allUnavailable).not.toHaveBeenCalled();
  });

  it('routes to all-unavailable (no empty panel) when the local reviewer is skipped and no remote reviewer succeeds', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as TestReviewService;
    reviewTestState.localEnabled = true;
    service.setLocalReviewDependenciesForTesting({ review: vi.fn() }, { list: () => [] });
    const allUnavailable = vi.fn();
    service.on('review:all-unavailable', allUnavailable);
    const result = vi.fn();
    service.on('review:result', result);

    await service.executeReviews(makeRequest({ timestamp: 123 }), [], 30);

    expect(allUnavailable).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      reviewId: 'review-1',
      reviewStartedAt: 123,
    });
    expect(result).not.toHaveBeenCalled();
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
