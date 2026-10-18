import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { sendAbortableReviewerMessage } from './review-execution-host';

vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: vi.fn() }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: vi.fn() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: vi.fn() }));
vi.mock('../core/system/provider-quota-service', () => ({ getProviderQuotaService: vi.fn() }));

describe('cancelled reviewer native usage settlement', () => {
  let rows: CostAttributionRecord[];
  let unsubscribe: () => void;
  beforeEach(() => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    rows = [];
    unsubscribe = subscribeCostAttribution(row => rows.push(row));
  });
  afterEach(() => { unsubscribe(); vi.unstubAllEnvs(); });

  it.each(['attached', 'event', 'zero', 'unknown', 'resolved'] as const)(
    'keeps cancellation immediate and records %s evidence once when the native send settles', async mode => {
    const abort = new AbortController();
    let rejectSend!: (error: Error) => void;
    let resolveSend!: (response: CliResponse) => void;
    const adapter = Object.assign(new EventEmitter(), {
      sendMessage: vi.fn(() => new Promise<CliResponse>((resolve, reject) => {
        rejectSend = reject; resolveSend = resolve;
      })),
      interrupt: vi.fn(),
      // Force-kill is asynchronous at the OS; its call can return before close.
      terminate: vi.fn(async () => undefined),
    });
    const addAbort = vi.spyOn(abort.signal, 'addEventListener');
    const removeAbort = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = sendAbortableReviewerMessage(adapter, { role: 'user', content: 'review fixture' }, abort.signal,
      undefined, { purpose: 'cross-model-review', provider: 'claude', model: 'fixture-model', instanceId: 'fixture-instance' });
    const cancelled = pending.catch(error => error);
    abort.abort();
    expect((await cancelled).message).toBe('Review cancelled');
    expect(removeAbort).toHaveBeenCalledWith('abort', addAbort.mock.calls.find(call => call[0] === 'abort')?.[1]);
    expect(rows).toHaveLength(0);

    const paid = { inputTokens: 100, outputTokens: 10, cost: 0.42 };
    if (mode === 'event') adapter.emit('usage', paid);
    if (mode === 'resolved') resolveSend({ id: 'fixture-response', role: 'assistant', content: '{}', usage: paid });
    else rejectSend(Object.assign(new Error('Native cancellation closed'), { name: 'AbortError',
      partialUsage: mode === 'attached' ? paid : mode === 'zero' ? { cost: 0 } : { inputTokens: 5 } }));
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({ purpose: 'cross-model-review', provider: 'claude', model: 'fixture-model',
      instanceId: 'fixture-instance', outcome: 'cancelled', costKnown: mode !== 'unknown',
      costSource: mode === 'unknown' ? 'unknown' : 'provider' });
    if (mode !== 'unknown') expect(rows[0].usage?.cost).toBe(mode === 'zero' ? 0 : 0.42);
    expect(adapter.listenerCount('usage')).toBe(0);
    expect(adapter.listenerCount('complete')).toBe(0);
    adapter.emit('usage', { cost: 1 });
    expect(rows).toHaveLength(1);
  });
});
