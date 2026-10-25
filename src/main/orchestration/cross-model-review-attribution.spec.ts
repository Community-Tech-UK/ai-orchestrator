import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { pauseConsults } from '../work-admission/consult-admission';

const state = vi.hoisted(() => ({ send: vi.fn(), cliType: 'gemini', create: vi.fn(), terminate: vi.fn<() => Promise<void>>(async () => undefined) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => state.cliType }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: (input: unknown) => { state.create(input); return { sendMessage: state.send, terminate: state.terminate }; } }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ crossModelReviewModelByProvider: { gemini: 'gemini-2.5-flash' } }) }) }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: (run: () => unknown) => run() }) }) }));
vi.mock('../core/system/provider-quota-service', () => ({ getProviderQuotaService: () => ({ getSnapshot: () => null }) }));

describe('cross-model reviewer attribution', () => {
  afterEach(() => { CrossModelReviewService._resetForTesting(); state.send.mockReset(); state.create.mockReset(); state.terminate.mockReset().mockResolvedValue(undefined); state.cliType = 'gemini'; });
  it.each(['delayed', 'failed'] as const)('keeps %s adapter teardown in the restart barrier after cancellation', async mode => {
    let finishTeardown!: () => void;
    const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
    if (mode === 'failed') state.terminate.mockRejectedValue(new Error('Provider is still running'));
    else state.terminate.mockImplementation(() => teardown);
    let rejectSend!: (error: Error) => void;
    state.send.mockImplementation(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; }));
    const request: ReviewDispatchRequest = { id: 'review-pause', instanceId: 'instance-example', primaryProvider: 'claude', workingDirectory: '/repo', content: 'example', taskDescription: 'Review', reviewDepth: 'structured', timestamp: 1000, classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 } };
    const service = CrossModelReviewService.getInstance() as unknown as { executeOneReview: (request: ReviewDispatchRequest, provider: string, timeout: number, signal: AbortSignal) => Promise<unknown> };
    const abort = new AbortController();
    const pending = service.executeOneReview(request, 'gemini', 30, abort.signal);
    await vi.waitFor(() => expect(state.send).toHaveBeenCalled());
    abort.abort();
    await expect(pending).rejects.toThrow('Review cancelled');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeTeardown = stopped;
    if (mode === 'failed') { state.terminate.mockResolvedValue(undefined); await pauseConsults(); }
    else finishTeardown();
    rejectSend(new Error('Provider stopped')); await pausing;
    expect(stoppedBeforeTeardown).toBe(false);
  });
  it.each(['repair', 'error', 'budget-exceeded'] as const)('records exactly one row per %s send', async mode => {
    if (mode === 'budget-exceeded') {
      state.cliType = 'claude';
      state.send.mockResolvedValue({ content: 'invalid partial verdict', metadata: { budgetExceeded: true }, usage: { cost: 1.01 } });
    }
    if (mode === 'error') state.send.mockRejectedValue(new Error('provider failed'));
    else if (mode === 'repair') state.send.mockResolvedValueOnce({ content: 'invalid', usage: { inputTokens: 20, outputTokens: 3 } })
      .mockResolvedValueOnce({ content: JSON.stringify({ correctness: { reasoning: 'ok', score: 4, issues: [] }, completeness: { reasoning: 'ok', score: 4, issues: [] }, security: { reasoning: 'ok', score: 4, issues: [] }, consistency: { reasoning: 'ok', score: 4, issues: [] }, overall_verdict: 'APPROVE', summary: 'ok' }), usage: { cost: 0.01 } });
    const request: ReviewDispatchRequest = { id: 'review-example', instanceId: 'instance-example', primaryProvider: 'claude', workingDirectory: '/repo', content: 'example', taskDescription: 'Review the change', reviewDepth: 'structured', timestamp: 1000, classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 } };
    const service = CrossModelReviewService.getInstance() as unknown as { executeOneReview: (request: ReviewDispatchRequest, provider: string, timeout: number, signal: AbortSignal) => Promise<unknown> };
    const records: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    try {
      const pending = service.executeOneReview(request, 'gemini', 30, new AbortController().signal);
      if (mode === 'error') await expect(pending).rejects.toThrow('provider failed');
      else if (mode === 'budget-exceeded') await expect(pending).rejects.toThrow('Reviewer budget exceeded');
      else await pending;
      expect(records).toHaveLength(mode === 'repair' ? 2 : 1);
      expect(records.every(record => record.purpose === 'cross-model-review' && record.correlationId === request.id && record.instanceId === request.instanceId)).toBe(true);
      expect(records.at(-1)?.costSource).toBe(mode === 'error' ? 'unknown' : 'provider');
      expect(records.at(-1)?.outcome).toBe(mode === 'repair' ? 'success' : mode);
      if (mode === 'budget-exceeded') {
        expect(state.send).toHaveBeenCalledOnce();
        expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ maxTurns: 8, maxBudgetUsd: 1 }) }));
      } else expect(state.create.mock.calls[0]?.[0].options.maxTurns).toBeUndefined();
    } finally { stop(); }
  });
});
