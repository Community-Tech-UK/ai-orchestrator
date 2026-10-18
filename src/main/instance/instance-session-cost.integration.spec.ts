import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, ContextUsage, InstanceStatus } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('../cli/adapters/claude-transcript-registry', () => ({ nativeTranscriptExists: () => true, nativeSessionIdInUse: () => false, readLastClaudeCostState: () => undefined }));
vi.mock('../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: vi.fn() }));
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { getCostTracker } from '../core/system/cost-tracker';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { InstanceCommunicationManager } from './instance-communication';
import { resolveIterationCost } from '../orchestration/loop-iteration-cost';

const attributionSubscriptions: (() => void)[] = [];

function harness(drainContextEvidence?: () => Promise<void>) {
  const adapter = new ClaudeCliAdapter({ sessionId: 'cost-session', workingDirectory: '/tmp', residentClaude: true, model: 'claude-opus-5' });
  const instance = {
    id: 'cost-instance', sessionId: 'cost-session', provider: 'claude', currentModel: 'claude-opus-5',
    agentId: 'build', parentId: null, status: 'busy', restartEpoch: 0, requestCount: 1,
    outputBuffer: [], totalTokensUsed: 0, contextUsage: { used: 0, total: 200000, percentage: 0 },
    metadata: {},
  } as unknown as Instance;
  const updates: { status: InstanceStatus; cost?: number }[] = [];
  const queueUpdate = vi.fn((_id: string, status: InstanceStatus, usage?: ContextUsage) => {
    updates.push({ status, cost: usage?.costEstimate });
  });
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(), deleteAdapter: () => false,
    drainContextEvidence, queueUpdate, processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), emitProviderRuntimeEvent: vi.fn(),
  });
  manager.setupAdapterEvents(instance.id, adapter);
  const attributionRows: CostAttributionRecord[] = [];
  attributionSubscriptions.push(subscribeCostAttribution(row => attributionRows.push(row)));
  const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
  const children: ChildProcess[] = [];
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 10001 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null }) as unknown as ChildProcess;
    children.push(child);
    return child;
  });
  const emit = (value: unknown) => children.at(-1)?.stdout?.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  return { adapter, instance, queueUpdate, updates, children, spawn, emit, attributionRows };
}

beforeEach(() => getCostTracker().clearEntries());
afterEach(() => { for (const unsubscribe of attributionSubscriptions.splice(0)) unsubscribe(); vi.restoreAllMocks(); getCostTracker().clearEntries(); });

describe('Claude adapter → communication → real CostTracker', () => {
  it.each([false, true])('settles an errored resident turn once with native cost (one stdout chunk: %s)', async (sameChunk) => {
    const { adapter, instance, emit, children, attributionRows } = harness();
    const completions: CliResponse[] = [];
    adapter.on('complete', response => completions.push(response));
    const result = (cost: number, input: number, output: number) => ({
      type: 'result', subtype: 'success', total_cost_usd: cost,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { 'claude-opus-5': { inputTokens: input, outputTokens: output, costUSD: cost, ...(cost === 0.75 ? { contextWindow: 1000000 } : {}) } },
    });
    await adapter.spawn();
    await adapter.sendInput('First turn'); emit(result(0.5, 100, 20));
    await adapter.sendInput('Failed turn');
    const failedMessages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } },
      result(0.75, 200, 40),
    ];
    if (sameChunk) children[0].stdout?.emit('data', Buffer.from(failedMessages.map(value => JSON.stringify(value)).join('\n') + '\n'));
    else for (const message of failedMessages) {
      emit(message);
      if (message.type === 'error') {
        // Real controller error cleanup gets its event-loop turn before the
        // native trailing frame; termination must drain rather than price early.
        await Promise.resolve(); await Promise.resolve();
        expect(getCostTracker().getEntries()).toHaveLength(1);
      }
    }
    expect(completions).toHaveLength(2);
    expect(completions[1].metadata?.['turnErrored']).toBe(true);
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(2));
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(0.75, 8);
    expect(adapter.getCapabilities().contextWindow).toBe(1000000);
    await adapter.sendInput('Next turn'); emit(result(1, 300, 60));
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(3));
    expect(completions).toHaveLength(3);
    expect(completions[2].usage?.byModel).toEqual([{ model: 'claude-opus-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 }]);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(1, 8);
    expect(instance.contextUsage.costEstimate).toBeCloseTo(1, 8);
    expect(attributionRows).toHaveLength(3);
    expect(attributionRows.map(row => row.usage?.cost)).toEqual([0.5, 0.25, 0.25]);
    expect(attributionRows.every(row => row.costSource === 'provider')).toBe(true);
  });

  it('keeps the failed-turn settlement across later input and never completes that input from the old result', async () => {
    const { adapter, emit, instance, queueUpdate } = harness();
    const completions: CliResponse[] = [];
    adapter.on('complete', response => completions.push(response));
    await adapter.spawn();
    await adapter.sendInput('Failed turn');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Old partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
    emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
    expect(completions).toHaveLength(1);
    await adapter.sendInput('Later input');
    emit({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 20 } });
    expect(completions).toHaveLength(1);
    expect(queueUpdate).toHaveBeenLastCalledWith(instance.id, instance.status, expect.objectContaining({ costEstimate: 0.25 }));
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'New work' }], usage: { input_tokens: 50, output_tokens: 10 } } });
    emit({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 50, output_tokens: 10 } });
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(2));
    expect(completions).toHaveLength(2);
    expect(completions[1].content).toBe('New work');
    expect(completions[1].usage).toMatchObject({ inputTokens: 50, outputTokens: 10, cost: 0.25 });
    expect(instance.contextUsage.costEstimate).toBeCloseTo(0.5, 8);
  });

  it.each(['zero', 'absent'] as const)('retains observed paid tokens when the failed final counters are %s', async (counters) => {
    const { adapter, emit } = harness();
    await adapter.spawn(); await adapter.sendInput('Failed turn');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
    emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
    emit({ type: 'result', total_cost_usd: 0.25,
      ...(counters === 'zero' ? { usage: { input_tokens: 0, output_tokens: 0 } } : {}) });
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(1));
    expect(getCostTracker().getEntries()[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cost: 0.25 });
  });

  it('settles a fragmented result without a final newline when stdout is flushed on process exit', async () => {
    const { adapter, emit, children, attributionRows } = harness();
    const completions: CliResponse[] = [];
    adapter.on('complete', response => completions.push(response));
    await adapter.spawn(); await adapter.sendInput('Failed turn');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
    emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
    const result = JSON.stringify({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 20 } });
    children[0].stdout?.emit('data', Buffer.from(result.slice(0, 17)));
    children[0].stdout?.emit('data', Buffer.from(result.slice(17)));
    children[0].emit('exit', 1, null);
    children[0].emit('close', 1, null);
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(1));
    expect(completions).toHaveLength(1);
    expect(getCostTracker().getEntries()[0].cost).toBe(0.25);
    expect(attributionRows).toHaveLength(1);
    expect(attributionRows[0]).toMatchObject({ costSource: 'provider', usage: { cost: 0.25 } });
  });

  it.each(['exit', 'terminate'] as const)('books observed fallback exactly once when %s ends a failed turn without a native result', async (ending) => {
    const { adapter, emit, children, instance } = harness();
    const completions: CliResponse[] = [];
    const rows: CostAttributionRecord[] = [];
    const unsubscribe = subscribeCostAttribution(row => rows.push(row));
    adapter.on('complete', response => completions.push(response));
    try {
      await adapter.spawn(); await adapter.sendInput('Failed turn');
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
      emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
      expect(completions).toHaveLength(1);
      expect(getCostTracker().getEntries()).toHaveLength(0);
      if (ending === 'exit') { children[0].emit('exit', 1, null); children[0].emit('close', 1, null); }
      else await adapter.terminate(false);
      await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(1));
      await adapter.terminate(false);
      expect(completions).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ costSource: 'priced', usage: { inputTokens: 100, outputTokens: 20 } });
      expect(getCostTracker().getEntries()[0].cost).toBeGreaterThan(0);
      expect(instance.contextUsage.costEstimate).toBe(getCostTracker().getEntries()[0].cost);
    } finally { unsubscribe(); }
  });

  it('captures failed call identity and purpose before a later session/provider/model change', async () => {
    const { adapter, emit, instance } = harness();
    instance.metadata = { spendPurpose: 'automation' };
    const rows: CostAttributionRecord[] = [];
    const unsubscribe = subscribeCostAttribution(row => rows.push(row));
    try {
      await adapter.spawn(); await adapter.sendInput('Failed turn');
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid partial work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
      emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
      instance.sessionId = 'later-session'; instance.provider = 'copilot'; instance.currentModel = 'later-model';
      instance.metadata['spendPurpose'] = 'channel';
      emit({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 20 } });
      await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(1));
      expect(getCostTracker().getEntries()[0]).toMatchObject({ sessionId: 'cost-session', model: 'claude-opus-5', cost: 0.25 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: 'automation', provider: 'claude', model: 'claude-opus-5', costSource: 'provider', usage: { cost: 0.25 } });
      expect(instance.contextUsage.costEstimate).toBe(0.25);
    } finally { unsubscribe(); }
  });

  it.each([false, true])('pins billing identity before context drain (native result before drain: %s)', async nativeFirst => {
    let release!: () => void;
    const drain = new Promise<void>(resolve => { release = resolve; });
    const { adapter, emit, instance, attributionRows, queueUpdate } = harness(() => drain);
    instance.metadata = { spendPurpose: 'automation' };
    instance.parentId = 'original-parent';
    await adapter.spawn(); await adapter.sendInput('Failed turn');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid work' }], usage: { input_tokens: 100, output_tokens: 20 } } });
    emit({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded' } });
    instance.sessionId = 'later-session'; instance.provider = 'copilot'; instance.currentModel = 'later-model';
    instance.metadata['spendPurpose'] = 'channel'; instance.parentId = 'later-parent'; instance.agentId = 'later-agent';
    const previousContext = instance.contextUsage;
    instance.contextUsage = { used: 0, total: 200000, percentage: 0, costEstimate: 1 };
    const result = () => emit({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 20 } });
    if (nativeFirst) result();
    expect(getCostTracker().getEntries()).toHaveLength(0);
    release();
    await Promise.resolve(); await Promise.resolve();
    if (!nativeFirst) result();
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(1));
    expect(getCostTracker().getEntries()[0]).toMatchObject({ sessionId: 'cost-session', model: 'claude-opus-5', cost: 0.25 });
    expect(attributionRows).toHaveLength(1);
    expect(attributionRows[0]).toMatchObject({ purpose: 'automation', provider: 'claude', model: 'claude-opus-5',
      parentId: 'original-parent', agentId: 'build', costSource: 'provider', usage: { cost: 0.25 } });
    expect(instance.contextUsage.costEstimate).toBe(1.25);
    expect(previousContext.costEstimate).toBeUndefined();
    expect(queueUpdate).toHaveBeenLastCalledWith(instance.id, instance.status, instance.contextUsage);
  });

  it('books two resident turns once, keeps recorded spend through occupancy and provider cost events, then continues after resume', async () => {
    const { adapter, instance, emit, spawn, queueUpdate } = harness();
    await adapter.spawn();
    for (const [round, cumulative] of [0.5, 1.25].entries()) {
      await adapter.sendInput(`turn ${round + 1}`);
      emit({ type: 'system', subtype: 'context_usage', usage: { input_tokens: 100, output_tokens: 20 } });
      emit({ type: 'result', subtype: 'success', session_id: 'cost-session', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: cumulative });
      await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(round + 1));
      expect(instance.contextUsage.costEstimate).toBeCloseTo(cumulative);
      expect(queueUpdate).toHaveBeenLastCalledWith(instance.id, instance.status, expect.objectContaining({ costEstimate: cumulative }));
    }
    expect(getCostTracker().getEntries().map(row => row.cost).sort()).toEqual([0.5, 0.75]);
    adapter.emit('context', { used: 55, total: 200000, percentage: 0.0275, costEstimate: 99 });
    adapter.emit('cost', { costEstimate: 99 });
    expect(instance.contextUsage.costEstimate).toBe(1.25);
    expect(instance.contextUsage.used).toBe(55);
    instance.status = 'hibernated';
    adapter.emit('context', { used: 10, total: 200000, percentage: 0.005 });
    expect(instance.contextUsage.costEstimate).toBe(1.25);
    instance.status = 'idle';
    adapter.setResume(true);
    const processField = adapter as unknown as { process: ChildProcess | null };
    processField.process = null;
    await adapter.spawn();
    expect(spawn.mock.calls[1][0]).toContain('--resume');
    await adapter.sendInput('after wake');
    emit({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 1.5 });
    await vi.waitFor(() => expect(getCostTracker().getEntries()).toHaveLength(3));
    expect(instance.contextUsage.costEstimate).toBeCloseTo(1.5);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(1.5);
  });

  it('settles three same-session one-shot loop rounds as disjoint deltas', async () => {
    const { adapter, instance, emit, children, spawn, updates } = harness();
    const roundCents: number[] = [];
    for (const [round, cumulative] of [0.4, 0.9, 1.2].entries()) {
      const pending = adapter.sendMessage({ role: 'user', content: `loop round ${round + 1}` });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(round + 1));
      emit({ type: 'system', subtype: 'init', session_id: 'cost-session' });
      emit({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: cumulative });
      children.at(-1)?.emit('close', 0);
      const response = await pending;
      roundCents.push(resolveIterationCost({ tokens: response.usage?.totalTokens ?? 0, costUsd: response.usage?.cost }).costCents);
      expect(response.usage?.cost).toBeCloseTo([0.4, 0.5, 0.3][round]);
      expect(updates.at(-1)?.cost).toBeCloseTo(cumulative);
      adapter.setResume(true);
    }
    expect(getCostTracker().getEntries()).toHaveLength(3);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(1.2);
    expect(instance.contextUsage.costEstimate).toBeCloseTo(1.2);
    expect(roundCents).toEqual([40, 50, 30]);
    expect(roundCents.reduce((sum, cents) => sum + cents, 0)).toBe(120);
    expect(spawn.mock.calls.slice(1).every(([args]) => args.includes('--resume'))).toBe(true);
  });

  it('retains the native paid budget-stop even when final token counts are zero', () => {
    const { adapter, instance } = harness();
    const response: CliResponse = {
      id: 'budget-result', content: '', role: 'assistant',
      metadata: { claudeResultSubtype: 'error_max_budget_usd', budgetExceeded: true },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.0064186 },
    };
    adapter.emit('complete', response);
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(getCostTracker().getEntries()[0].cost).toBe(0.0064186);
    expect(instance.contextUsage.costEstimate).toBe(0.0064186);
  });

  it('prices observed known model usage and leaves unknown or estimated attribution unknown', () => {
    const { adapter, instance } = harness();
    const rows: CostAttributionRecord[] = [];
    const unsubscribe = subscribeCostAttribution(row => rows.push(row));
    try {
      adapter.emit('usage', { inputTokens: 100, outputTokens: 20 });
      expect(rows[0]).toMatchObject({ costSource: 'priced', costKnown: true });
      expect(rows[0].usage?.cost).toBeGreaterThan(0);
      instance.currentModel = 'obviously-unpriced-model';
      adapter.emit('usage', { inputTokens: 100, outputTokens: 20 });
      expect(rows[1]).toMatchObject({ costSource: 'unknown', costKnown: false });
      instance.currentModel = 'claude-opus-5';
      adapter.emit('usage', { inputTokens: 100, outputTokens: 20, isEstimated: true });
      expect(rows[2]).toMatchObject({ costSource: 'unknown', costKnown: false });
    } finally { unsubscribe(); }
  });
});
