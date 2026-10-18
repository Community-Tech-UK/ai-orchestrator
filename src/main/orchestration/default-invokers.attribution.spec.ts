import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostAttributionRecord } from '../core/system/cost-attribution';

const mocks = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn(), review: new Map<string, (payload: unknown) => Promise<void>>(), verify: new Map<string, (payload: unknown) => Promise<void>>() }));
vi.mock('../agents/review-coordinator', () => ({ getReviewCoordinator: () => ({ listenerCount: () => 0, on: (event: string, listener: never) => mocks.review.set(event, listener) }) }));
vi.mock('./multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: () => ({ listenerCount: () => 0, on: (event: string, listener: never) => mocks.verify.set(event, listener) }) }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: mocks.create }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: mocks.execute }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'claude' }) }) }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_provider: unknown, options: unknown) => options }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { registerDefaultMultiVerifyInvoker, registerDefaultReviewInvoker } from './default-invokers';
import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { markProviderDispatchNotStarted } from '../cli/adapters/provider-dispatch-status';

describe('default dispatched call attribution', () => {
  let records: CostAttributionRecord[];
  let unsubscribe: () => void;
  let adapter: EventEmitter & { sendMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks(); records = [];
    unsubscribe = subscribeCostAttribution(record => records.push(record));
    adapter = Object.assign(new EventEmitter(), { sendMessage: vi.fn(), terminate: vi.fn(async () => undefined) });
    mocks.create.mockReturnValue(adapter);
    mocks.execute.mockImplementation((run: () => Promise<unknown>) => run());
    const manager = { getInstance: () => ({ id: 'session', provider: 'claude', workingDirectory: '/tmp' }) };
    registerDefaultReviewInvoker(manager as never); registerDefaultMultiVerifyInvoker(manager as never);
  });
  afterEach(() => unsubscribe());
  const invoke = (purpose: 'review' | 'verify') => {
    const payload = { correlationId: 'call', instanceId: 'session', agentId: 'checker', model: 'haiku',
      reviewId: 'review', requestId: 'verify', systemPrompt: 'Check the work', context: 'reference', userPrompt: 'Check', callback: vi.fn() };
    return (purpose === 'review' ? mocks.review.get('review:invoke-agent')! : mocks.verify.get('verification:invoke-agent')!)(payload);
  };

  it.each(['review', 'verify'] as const)('records an actual rejected %s send exactly once', async purpose => {
    adapter.sendMessage.mockRejectedValue(new Error('Dispatched provider failed'));
    await invoke(purpose);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose, provider: 'claude', model: 'haiku', correlationId: 'call', instanceId: 'session', outcome: 'error', costSource: 'unknown', costKnown: false });
    expect(adapter.listenerCount('usage')).toBe(0);
    expect(adapter.listenerCount('complete')).toBe(0);
  });
  it('records neither breaker refusals nor failed adapter construction', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('Circuit open'));
    await invoke('review');
    expect(mocks.create).not.toHaveBeenCalled(); expect(records).toEqual([]);
    mocks.create.mockImplementationOnce(() => { throw new Error('Adapter unavailable'); });
    await invoke('verify');
    expect(adapter.sendMessage).not.toHaveBeenCalled(); expect(records).toEqual([]);
  });
  it('preserves reported paid usage when a dispatched send is cancelled', async () => {
    adapter.sendMessage.mockImplementation(async () => {
      adapter.emit('usage', { inputTokens: 30, outputTokens: 5, cost: 0.25 });
      throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
    });
    await invoke('review');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'cancelled', costSource: 'provider', usage: { inputTokens: 30, outputTokens: 5, cost: 0.25 } });
  });
  it('preserves error-attached partial paid usage and keeps unknown cost explicit', async () => {
    adapter.sendMessage.mockRejectedValue(Object.assign(new Error('Provider exited'), { partialUsage: { cost: 0.1, outputTokens: 7 } }));
    await invoke('verify');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'error', costSource: 'provider', usage: { cost: 0.1, outputTokens: 7 } });
  });
  it('retains a paid usage event when the cancellation error carries only estimated tokens', async () => {
    adapter.sendMessage.mockImplementation(async () => {
      adapter.emit('usage', { cost: 0.25, inputTokens: 30 });
      throw Object.assign(new Error('Request cancelled'), { name: 'AbortError', partialUsage: { outputTokens: 5, cost: undefined } });
    });
    await invoke('review');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'cancelled', costSource: 'provider', usage: { inputTokens: 30, outputTokens: 5, cost: 0.25 } });
  });
  it('records a successful response once even when complete is emitted first', async () => {
    adapter.sendMessage.mockImplementation(async () => {
      const response = { id: 'response', role: 'assistant', content: 'Checked', usage: { cost: 0.3, totalTokens: 10 } };
      adapter.emit('complete', response); return response;
    });
    await invoke('verify');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'verify', outcome: 'success', costSource: 'provider', usage: { cost: 0.3 } });
  });
  it.each(['review', 'verify'] as const)('excludes a real native no-child %s refusal', async purpose => {
    const real = new ClaudeCliAdapter({ workingDirectory: '/disposable-absent-fixture-directory/does-not-exist', timeout: 150 });
    real.on('error', () => undefined);
    const spawned = vi.fn();
    real.on('spawned', spawned);
    mocks.create.mockReturnValue(real);
    try {
      await invoke(purpose);
      expect(mocks.create).toHaveBeenCalledOnce();
      expect(spawned).not.toHaveBeenCalled();
      expect(real.isRunning()).toBe(false);
      expect(records).toEqual([]);
      expect(real.listenerCount('usage')).toBe(0);
      expect(real.listenerCount('complete')).toBe(0);
    } finally { await real.terminate(false); }
  });
  it.each([{ cost: 0.25 }, { cost: 0 }, { inputTokens: 30 }])('preserves native evidence overriding refusal provenance: %j', async usage => {
    adapter.sendMessage.mockImplementation(async () => {
      adapter.emit('usage', usage);
      throw Object.assign(markProviderDispatchNotStarted(new Error('Local write failed')), { partialUsage: { cost: undefined } });
    });
    await invoke('review');
    expect(records).toHaveLength(1);
    expect(records[0].usage).toMatchObject(usage);
    expect(records[0]).toMatchObject({ outcome: 'error', costSource: 'cost' in usage ? 'provider' : 'unknown', costKnown: 'cost' in usage });
    expect(adapter.listenerCount('usage')).toBe(0);
    expect(adapter.listenerCount('complete')).toBe(0);
  });
});
