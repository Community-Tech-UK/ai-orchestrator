import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { sendRecordedOrchestrationCall } from './orchestration-call-recording';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
const state = vi.hoisted(() => ({ coordinator: null as unknown as EventEmitter, adapter: null as unknown as ClaudeCliAdapter }));
vi.mock('./loop-coordinator', () => ({ getLoopCoordinator: () => state.coordinator }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: () => state.adapter }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'claude', providerAccountProfiles: [], providerAccountPools: {}, auxiliaryLlmRoutingClassificationEnabled: false }), get: () => undefined }) }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: async (fn: () => Promise<unknown>) => fn() }) }) }));
vi.mock('./invocation-model-resolver', () => ({ resolveModelForInvocation: () => 'claude-opus-5', shouldPreferScaffoldingProvider: () => false, isExplicitModel: () => true, classifyCheapModelEligible: async () => false, _resetCheapEligibleCacheForTesting: () => undefined }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_cli: unknown, options: unknown) => options }));
vi.mock('./loop-adapter-borrow', () => ({ decideAdapterBorrow: async () => ({ borrowedFromInstance: false, adapterLoan: undefined, liveInstance: undefined, reusedAdapter: undefined }) }));
vi.mock('./loop-safety-advisor', () => ({ registerLoopSafetyAdvisor: () => undefined }));
vi.mock('./loop-invoker-capture', async importOriginal => ({
  ...await importOriginal<typeof import('./loop-invoker-capture')>(),
  createLoopInvocationCapture: () => ({ recordActivity: () => undefined, finalize: () => ({ filesRead: [], toolCalls: [], toolRwLockConflicts: [], unresolvedToolCalls: [] }) }),
  createToolTimeoutWatchdogWidener: () => ({ onToolUse: () => undefined, onToolResult: () => undefined, onIterationSettled: () => undefined }),
  extractFinishReasonFromResponse: () => undefined,
}));
vi.mock('./loop-attempt-observation', () => ({ createAttemptDeltaObserver: () => ({ observe: () => ({ changes: [], coverage: 'complete', sources: [] }), failureNote: () => undefined }), buildObservedAttemptEvidence: () => ({}) }));
vi.mock('./loop-provider-event-capture', () => ({ observeLoopProviderRuntimeEvents: () => () => undefined }));
vi.mock('./loop-output-externalize', () => ({ maybeExternalizeLoopOutput: async (output: string) => output }));
import { registerDefaultLoopInvoker } from './default-invokers';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function publicLoopIteration(adapter: ClaudeCliAdapter, regular = false) {
  if (regular)
    return sendRecordedOrchestrationCall(adapter, { taskType: 'loop-orchestration:claude', correlationId: 'disposable-control', provider: 'claude', model: 'claude-opus-5' }, () => adapter.sendMessage({ role: 'user', content: 'Disposable regular timeout control', metadata: { continueWhileActiveOnTimeout: true, activeTimeoutMs: 25 } }));
  state.coordinator = new EventEmitter();
  state.adapter = adapter;
  let lastResponse: unknown;
  const original = adapter.sendMessage.bind(adapter);
  vi.spyOn(adapter, 'sendMessage').mockImplementation(async (message) => {
    expect(message.metadata).toEqual({ allowPartialOnTimeout: true, continueWhileActiveOnTimeout: true, activeTimeoutMs: 25 });
    try {
      lastResponse = await original(message);
      return lastResponse as Awaited<ReturnType<typeof original>>;
    } catch (error) {
      lastResponse = error;
      throw error;
    }
  });
  registerDefaultLoopInvoker({ getInstance: () => undefined, queueInstanceUpdate: () => undefined } as never);
  const result = await new Promise<Record<string, unknown>>(resolve => state.coordinator.emit('loop:invoke-iteration', { correlationId: 'disposable-public-loop', loopRunId: 'disposable-public-loop', chatId: 'disposable-chat', provider: 'claude', model: 'claude-opus-5', workspaceCwd: '/tmp', stage: 'IMPLEMENT', seq: 0, idempotencyKey: 'disposable-output', prompt: 'Disposable loop fixture', config: { contextStrategy: 'fresh-child' }, iterationTimeoutMs: 150, streamIdleTimeoutMs: 25, callback: resolve }));
  if ('error' in result)
    throw lastResponse instanceof Error ? lastResponse : new Error(String(result['error']));
  return lastResponse as Awaited<ReturnType<typeof original>>;
}
it.each([
  { mode: 'partial-paused', cost: 0.25 },
  { mode: 'partial-unpaused', cost: 0.25 },
  { mode: 'regular-paused', cost: 0.25 },
  { mode: 'partial-zero', cost: 0 },
  { mode: 'partial-no-native-cost', cost: undefined },
  { mode: 'partial-native-error', cost: 0.25 },
  { mode: 'partial-no-final-lf', cost: 0.25 },
])('native finality $mode', async ({mode, cost}) => {
  vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  // Keep real child I/O, but charge the watchdog only after the buffered result
  // is acknowledged. Interpreter startup must not choose the no-output branch.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const adapter = new ClaudeCliAdapter({ model: 'claude-opus-5', timeout: 150 });
  adapter.on('error', () => undefined);
  let child!: ChildProcessWithoutNullStreams;
  let closed!: Promise<unknown>;
  let drainedRaw = '';
  let closeSeen = false;
  const completed: {
    closed: boolean;
    usage: unknown;
  }[] = [];
  adapter.on('complete', response => completed.push({ closed: closeSeen, usage: response.usage }));
  let paused = false;
  let finalWritten = false;
  let acknowledgeFinal!: () => void;
  const finalAcknowledged = new Promise<void>(resolve => { acknowledgeFinal = resolve; });
  let deadline!: ReturnType<typeof setTimeout>;
  const fixtureDeadline = new Promise<never>((_resolve, reject) => {
    deadline = realSetTimeout(() => reject(new Error('Disposable CLI fixture did not settle within 5 seconds')), 5_000);
  });
  const paid = { type: 'assistant', message: { content: [{ type: 'text', text: 'PARTIAL_FIXTURE' }], usage: { input_tokens: 100, output_tokens: 10 } } };
  const result = { type: 'result', subtype: mode === 'partial-native-error' ? 'error_during_execution' : 'success',
    is_error: mode === 'partial-native-error', total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 10 },
    ...(cost !== undefined ? {modelUsage: {'claude-opus-5': {inputTokens: 100, outputTokens: 10, costUSD: cost}}} : {}),
  };
  vi.spyOn(adapter as unknown as {
    spawnProcess(args: string[]): ReturnType<typeof spawn>;
  }, 'spawnProcess').mockImplementation(() => {
    child = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(paid) + '\n')},()=>setTimeout(()=>{process.stdout.write(${JSON.stringify(JSON.stringify(result) + (mode === 'partial-no-final-lf' ? '' : '\n'))},()=>process.stderr.write('FINAL_WRITTEN'));},25));});setInterval(()=>{},1000);`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    closed = once(child, 'close');
    child.once('close', () => { closeSeen = true; });
    child.once('exit', () => child.stdout.resume());
    child.stdout.on('data', chunk => { drainedRaw += chunk.toString(); });
    child.stderr.on('data', chunk => {
      if (chunk.toString().includes('FINAL_WRITTEN')) {
        finalWritten = true;
        acknowledgeFinal();
      }
    });
    return child;
  });
  adapter.on('output', event => { if (event.type === 'assistant' && !paused && mode !== 'partial-unpaused') {
    paused = true;
    child.stdout.pause();
  } });
  const rows: CostAttributionRecord[] = [];
  const stop = subscribeCostAttribution(row => rows.push(row));
  try {
    const running = publicLoopIteration(adapter, mode === 'regular-paused')
      .then(response => ({ response, error: undefined }), error => ({ response: undefined, error }));
    await Promise.race([
      finalAcknowledged,
      running.then(() => { throw new Error('Disposable CLI settled before its final-write acknowledgement'); }),
      fixtureDeadline,
    ]);
    await vi.advanceTimersByTimeAsync(150);
    // The regular timeout deliberately drains for 250 ms before killing a
    // paused pipe. Keep the real close boundary; never advance its 3s fallback.
    if (mode === 'regular-paused') await vi.advanceTimersByTimeAsync(250);
    const actual = await Promise.race([running, fixtureDeadline]);
    const response = actual.response;
    expect(Boolean(response)).toBe(mode !== 'regular-paused' && mode !== 'partial-native-error');
    await Promise.race([closed, fixtureDeadline]);
    await new Promise(resolve => setImmediate(resolve));
    expect(adapter.listenerCount('usage')).toBe(0);
    expect(adapter.listenerCount('complete')).toBe(1);
    expect(completed).toHaveLength(1);
    expect(completed[0].closed).toBe(true);
    expect(rows[0].purpose).toBe('loop');
    expect(paused).toBe(mode !== 'partial-unpaused');
    expect(finalWritten).toBe(true);
    expect(drainedRaw).toContain(JSON.stringify(result));
    expect(child.signalCode).toBe('SIGKILL');
    expect(rows).toHaveLength(1);
    if (response)
      expect(response.metadata?.['timedOut']).toBe(true);
    else
      expect(actual.error?.message).toBe(mode === 'partial-native-error' ? 'Claude CLI reported error_during_execution' : 'Claude CLI timeout');
    expect(rows[0]).toMatchObject({ outcome: response ? 'success' : 'error', costSource: cost === undefined ? 'priced' : 'provider' });
    expect(rows[0].usage?.cost).toBe(cost ?? 0.00075);
    expect((response?.usage ?? actual.error?.partialUsage)?.cost).toBe(cost);
    if (cost !== undefined) expect((response?.usage ?? actual.error?.partialUsage)?.byModel).toEqual([
      {model: 'claude-opus-5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost},
    ]);
  } finally {
    realClearTimeout(deadline);
    vi.useRealTimers();
    stop();
    child?.stdout.resume();
    await adapter.terminate(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}, 15_000);
it('does not record a native dispatch refused before child creation', async () => {
  vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
  const adapter = new ClaudeCliAdapter({ workingDirectory: '/disposable-absent-fixture-directory/does-not-exist', model: 'claude-opus-5', timeout: 150 });
  adapter.on('error', () => undefined);
  const rows: CostAttributionRecord[] = [];
  const stop = subscribeCostAttribution(row => rows.push(row));
  try {
    const error = await publicLoopIteration(adapter).catch(error => error);
    expect(adapter.listenerCount('usage')).toBe(0);
    expect(adapter.listenerCount('complete')).toBe(0);
    expect(error.message).toContain('directory');
    expect(adapter.isRunning()).toBe(false);
    expect(rows).toHaveLength(0);
  } finally {
    stop();
    await adapter.terminate(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
