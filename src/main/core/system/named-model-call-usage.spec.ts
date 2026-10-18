import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { CliResponse } from '../../cli/adapters/base-cli-adapter';

const state = vi.hoisted(() => ({ adapter: undefined as unknown, constructionFails: false, allowed: true }));
vi.mock('../../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('../../cli/cli-detection', () => ({ isCliAvailable: async () => ({ installed: true }) }));
vi.mock('../../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: () => {
  if (state.constructionFails) throw new Error('Fixture construction refusal');
  return state.adapter;
} }) }));
vi.mock('../../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_type: unknown, options: unknown) => options }));
vi.mock('../../rlm/auxiliary-llm-service', () => ({ getAuxiliaryLlmService: () => ({ generate: async () => ({ text: '', decision: {
  source: 'fallback', allowFrontierFallback: true, fallbackDisposition: state.allowed ? 'allowed' : 'denied',
} }) }) }));
vi.mock('../../providers/automation-provider-exclusions', () => ({ filterProvidersForAutomation: () => ['claude'] }));
vi.mock('../../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 0 }) }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ crossModelReviewModelByProvider: { claude: 'fixture-requested-model' } }) }) }));
vi.mock('../../core/system/provider-quota-service', () => ({ getProviderQuotaService: () => ({ getSnapshot: () => null }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

import { invokeProviderOneShot } from '../../compare/council-provider-invoke';
import { MagicPromptService } from '../../magic-prompts/magic-prompt-service';
import { AutoTitleService } from '../../instance/auto-title-service';
import { ProviderReviewExecutionHost, sendAbortableReviewerMessage } from '../../review/review-execution-host';
import { subscribeCostAttribution, type CostAttributionRecord } from './cost-attribution';

const recap = JSON.stringify({ summary: 'Fixture', keyPoints: [], openQuestions: [], nextSteps: [] });
const paid = { inputTokens: 100, outputTokens: 10, cost: 0.42, byModel: [{ model: 'fixture-observed-model', inputTokens: 100, outputTokens: 10, costUsd: 0.42 }] };
const paths = ['council', 'compare', 'magic-prompt', 'title', 'reviewer', 'review-host'] as const;
type Path = typeof paths[number];

function run(path: Path, adapter: unknown, signal = new AbortController().signal): Promise<unknown> {
  state.adapter = adapter;
  if (path === 'council' || path === 'compare') return invokeProviderOneShot({
    resolveProvider: async () => 'claude', createAdapter: () => adapter as CliAdapter, now: () => 1000,
  }, 'claude', 'Fixture prompt', { purpose: path, signal, correlationId: 'fixture-correlation' });
  if (path === 'magic-prompt') return new MagicPromptService({ resolveProvider: async () => 'claude', createAdapter: () => adapter as CliAdapter })
    .run({ id: 'recap', text: 'Fixture conversation' });
  if (path === 'title') return AutoTitleService.getInstance().generateTitle('Please inspect this fixture module');
  if (path === 'review-host') return new ProviderReviewExecutionHost().dispatchReviewerPrompt('claude', 'Fixture review', '/fixture', signal,
    { purpose: 'fresh-eyes-review', correlationId: 'fixture-correlation' });
  return sendAbortableReviewerMessage(adapter as { sendMessage: () => Promise<CliResponse> }, { role: 'user', content: 'Fixture review' }, signal, undefined,
    { purpose: 'cross-model-review', taskType: 'cross-model-review:manual', provider: 'claude', model: 'fixture-requested-model', correlationId: 'fixture-correlation', instanceId: 'fixture-instance' });
}

function assertIdentity(path: Path, row: CostAttributionRecord): void {
  expect(row.purpose).toBe(path === 'title' ? 'helper' : path === 'reviewer' ? 'cross-model-review' : path === 'review-host' ? 'fresh-eyes-review' : path);
  if (path === 'title') expect(row.taskType).toBe('aux:titleGeneration');
  if (path === 'magic-prompt') expect(row.taskType).toBe('magic-prompt:recap');
  if (path === 'reviewer') expect(row).toMatchObject({ taskType: 'cross-model-review:manual', instanceId: 'fixture-instance' });
  if (!['title', 'magic-prompt'].includes(path)) expect(row.correlationId).toBe('fixture-correlation');
}

describe('actual named sends retain observed paid usage on settlement', () => {
  let rows: CostAttributionRecord[];
  let stop: () => void;
  beforeEach(() => {
    state.constructionFails = false; state.allowed = true;
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    rows = []; stop = subscribeCostAttribution(row => rows.push(row));
    AutoTitleService._resetForTesting();
  });
  afterEach(() => { stop(); vi.unstubAllEnvs(); AutoTitleService._resetForTesting(); });

  describe.each(paths)('%s public send', path => {
    it.each(['usage', 'complete', 'attached-usage', 'attached-partial', 'cancelled', 'unknown', 'zero', 'success'] as const)('records one row for %s evidence', async mode => {
      const adapter = Object.assign(new EventEmitter(), { sendMessage: vi.fn(async () => {
        if (mode === 'success') {
          adapter.emit('usage', paid);
          return { id: 'fixture-response', role: 'assistant' as const, content: path === 'magic-prompt' ? recap : 'Inspect Fixture Module', usage: { inputTokens: 5 } };
        }
        if (mode === 'usage') adapter.emit('usage', paid);
        if (mode === 'complete') adapter.emit('complete', { usage: paid });
        throw Object.assign(new Error('Fixture dispatched failure'), {
          ...(mode === 'cancelled' ? { name: 'AbortError' } : {}),
          ...(mode === 'attached-usage' ? { usage: paid } : {}),
          partialUsage: mode === 'attached-partial' || mode === 'cancelled' ? paid : mode === 'zero' ? { cost: 0 } : { inputTokens: 5, cost: undefined },
        });
      }), terminate: vi.fn(async () => undefined) });
      const abort = new AbortController();
      const add = vi.spyOn(abort.signal, 'addEventListener');
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      await run(path, adapter, abort.signal).catch(() => undefined);
      expect(adapter.sendMessage).toHaveBeenCalledOnce();
      expect(rows).toHaveLength(1);
      assertIdentity(path, rows[0]);
      expect(rows[0].provider).toBe(path === 'title' && mode === 'success' ? 'anthropic' : 'claude');
      if (path === 'reviewer' || path === 'review-host') {
        const handler = add.mock.calls.find(call => call[0] === 'abort')?.[1];
        expect(remove).toHaveBeenCalledWith('abort', handler);
      }
      expect(rows[0].outcome).toBe(mode === 'success' ? 'success' : mode === 'cancelled' ? 'cancelled' : 'error');
      expect(rows[0].costKnown).toBe(mode !== 'unknown');
      expect(rows[0].costSource).toBe(mode === 'unknown' ? 'unknown' : 'provider');
      if (mode !== 'unknown') expect(rows[0].usage?.cost).toBe(mode === 'zero' ? 0 : 0.42);
      if (!['unknown', 'zero'].includes(mode)) expect(rows[0].model).toBe('fixture-observed-model');
      expect(adapter.listenerCount('usage')).toBe(0);
      expect(adapter.listenerCount('complete')).toBe(0);
      adapter.emit('complete', { usage: { cost: 1 } });
      expect(rows).toHaveLength(1);
    });
  });

  it.each(['reviewer', 'review-host'] as const)('preserves in-flight cancellation and removes %s abort listeners', async path => {
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    let rejectSend!: (error: Error) => void;
    const adapter = Object.assign(new EventEmitter(), { sendMessage: vi.fn(() => new Promise<CliResponse>((_resolve, reject) => {
      rejectSend = reject; adapter.emit('usage', paid);
    })), interrupt: vi.fn(), terminate: vi.fn(async () => undefined) });
    const pending = run(path, adapter, abort.signal);
    const settled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledOnce());
    abort.abort(); await settled;
    rejectSend(new Error('Fixture late send rejection')); await Promise.resolve();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'cancelled', costKnown: true, usage: { cost: 0.42 } });
    expect(adapter.interrupt).toHaveBeenCalledOnce(); expect(adapter.terminate).toHaveBeenCalledOnce();
    const handler = add.mock.calls.find(call => call[0] === 'abort')?.[1];
    expect(remove).toHaveBeenCalledWith('abort', handler);
    expect(adapter.listenerCount('usage')).toBe(0); expect(adapter.listenerCount('complete')).toBe(0);
  });

  it.each(['reviewer', 'review-host'] as const)('retains %s attached usage when abort races its send rejection', async path => {
    const abort = new AbortController();
    const adapter = { sendMessage: vi.fn(async () => {
      abort.abort();
      throw Object.assign(new Error('Fixture paid cancellation'), { name: 'AbortError', partialUsage: paid });
    }), interrupt: vi.fn(), terminate: vi.fn(async () => undefined) };
    await run(path, adapter, abort.signal).catch(() => undefined);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'cancelled', costKnown: true, costSource: 'provider', usage: { cost: 0.42 } });
  });

  it.each(['council', 'reviewer', 'review-host'] as const)('does not send or book pre-cancelled %s', async path => {
    const abort = new AbortController(); abort.abort();
    const adapter = { sendMessage: vi.fn() };
    await run(path, adapter, abort.signal).catch(() => undefined);
    expect(adapter.sendMessage).not.toHaveBeenCalled(); expect(rows).toHaveLength(0);
  });

  it('does not book title authorization or construction refusals', async () => {
    const adapter = { sendMessage: vi.fn() };
    state.allowed = false; await run('title', adapter);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    state.allowed = true; state.constructionFails = true; await run('title', adapter);
    expect(adapter.sendMessage).not.toHaveBeenCalled(); expect(rows).toHaveLength(0);
  });

  it.each(['council', 'compare', 'magic-prompt', 'title', 'review-host'] as const)('does not book unsupported %s adapters', async path => {
    await run(path, {}).catch(() => undefined); expect(rows).toHaveLength(0);
  });
});
