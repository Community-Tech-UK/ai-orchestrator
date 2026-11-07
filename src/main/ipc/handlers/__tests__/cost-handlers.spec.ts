import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import { CostTracker } from '../../../core/system/cost-tracker';
import { sendValidatedRendererEvent } from '../../../event-bus/renderer-event-validation';

// Inject a FRESH real CostTracker per test (the class is kept; only the singleton
// accessor is overridden). Using the real tracker means the test drives the actual
// `cost-recorded` / `budget-alert` domain events — the event NAMES are what the
// production bug got wrong, so exercising them guards against regression.
const holder = vi.hoisted(() => ({ tracker: null as CostTracker | null }));

vi.mock('../../../core/system/cost-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/system/cost-tracker')>();
  return { ...actual, getCostTracker: () => holder.tracker };
});

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<IpcResponse>>(),
  handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<IpcResponse>) => {
    electronMocks.handlers.set(channel, handler);
  }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
}));

import { createInfrastructureDomain } from '../../../../preload/domains/infrastructure.preload';
import { registerCostHandlers } from '../cost-handlers';

interface Sent {
  channel: string;
  data: unknown;
}

function setup(usageFile?: string): { tracker: CostTracker; sent: Sent[] } {
  const sent: Sent[] = [];
  const windowManager = {
    getMainWindow: () => ({
      webContents: { send: (channel: string, data: unknown) => sent.push({ channel, data }) },
    }),
    sendToRenderer: (channel: string, data: unknown) => sent.push({ channel, data }),
  };
  registerCostHandlers({ windowManager: windowManager as never, ephemeralUsageFile: usageFile });
  // Registration rehydrates the shared test DB. Each case owns its ledger.
  holder.tracker!.clearEntries();
  return { tracker: holder.tracker!, sent };
}

describe('cost-handlers event forwarding', () => {
  beforeEach(() => {
    holder.tracker = new CostTracker();
    electronMocks.handlers.clear();
    electronMocks.handle.mockClear();
  });
  it('reads bounded temporary usage from its own log and rejects invalid limits', async () => {
    mkdirSync(resolve('_scratch'), { recursive: true });
    const dir = mkdtempSync(resolve('_scratch/step13-handler-'));
    try {
      const file = join(dir, 'usage.jsonl'); writeFileSync(file, '{"content":"MUST_NOT_CROSS_IPC"}\n');
      setup(file);
      expect(await invoke(IPC_CHANNELS.COST_GET_EPHEMERAL_USAGE, {limit: 10})).toMatchObject({success:true,data:{entries:[],skippedLines:1}});
      expect(await invoke(IPC_CHANNELS.COST_GET_EPHEMERAL_USAGE, {limit: 1001})).toMatchObject({success:false});
      expect(await invoke(IPC_CHANNELS.COST_GET_EPHEMERAL_USAGE, {filePath: file})).toMatchObject({success:false});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('returns numeric receipts through the actual preload Costs exposure', async () => {
    mkdirSync(resolve('_scratch'), { recursive: true });
    const dir = mkdtempSync(resolve('_scratch/step13-preload-'));
    try {
      const file = join(dir, 'usage.jsonl');
      const tokens = {input:80,cache:60,output:10,reasoning:null,total:90,estimated:false};
      writeFileSync(file, JSON.stringify({version:1,threadId:'native-example',jobId:'job-example',instanceId:'instance-example',
        kind:'plan-queue',trialKey:null,trialArm:'candidate',requests:null,requestsAvailable:false,tokens,
        helpers:{count:null,tokens:{input:null,cache:null,output:null,reasoning:null,total:null,estimated:false}},
        compactions:null,startedAt:100,endedAt:200,durationMs:100,finishReason:'exec-exit'}) + '\n');
      setup(file);
      const api = createInfrastructureDomain({ invoke: (channel: string, payload: unknown) => invoke(channel, payload) } as never, IPC_CHANNELS as never);
      expect(await api.costGetEphemeralUsage(5)).toMatchObject({success:true,data:{entries:[{threadId:'native-example',
        tokens:{input:80,cache:60,output:10,reasoning:null,total:90},requests:null,helpers:{count:null}}]}});
    } finally { rmSync(dir, {recursive:true,force:true}); }
  });
  it.each([{startTime:2,endTime:1},{startTime:-1},{endTime:Infinity},{startTime:'date'}])(
    'rejects an invalid purpose-summary range %s',async payload=>{
      setup();const result=await invoke(IPC_CHANNELS.COST_GET_PURPOSE_SUMMARY,payload);
      expect(result.success).toBe(false);expect(result.error?.code).toBe('COST_GET_PURPOSE_SUMMARY_FAILED');
    });
  it('accepts an optional purpose-summary range',async()=>{
    setup();expect((await invoke(IPC_CHANNELS.COST_GET_PURPOSE_SUMMARY)).success).toBe(true);
  });

  it.each([{ startTime: 2, endTime: 1 }, { startTime: -1 },
    { endTime: Infinity }, { startTime: 'date' }])('rejects an invalid purpose range %j', async payload => {
    setup();
    const result = await invoke(IPC_CHANNELS.COST_GET_PURPOSE_SUMMARY, payload);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COST_GET_PURPOSE_SUMMARY_FAILED');
  });

  it('accepts an optional read-only purpose range', async () => {
    setup();
    const result = await invoke(IPC_CHANNELS.COST_GET_PURPOSE_SUMMARY);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ byPurpose: [], byProvider: [], totals: { key: 'all' } });
  });

  it.each([{}, { instanceId: 42 }, { instanceId: '' }, { instanceId: 'i', sessionId: 5 }])('validates the session breakdown payload %j', async payload => {
    setup();
    expect((await invoke(IPC_CHANNELS.COST_GET_SESSION_BREAKDOWN, payload)).success).toBe(false);
  });
  it('returns a database-backed breakdown through the renderer channel', async () => {
    const { tracker } = setup();
    tracker.recordUsage('breakdown-instance', 'breakdown-session', 'sonnet', 100, 10, 0, 0, 0.01);
    const response = await invoke(IPC_CHANNELS.COST_GET_SESSION_BREAKDOWN, { instanceId: 'breakdown-instance', sessionId: 'breakdown-session' });
    expect(response).toMatchObject({ success: true, data: { turns: 1, totalCostUsd: 0.01 } });
  });

  it('handles COST_GET_HISTORY with the same stored entries used by the cost page', async () => {
    const { tracker } = setup();
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 1);

    const result = await invoke(IPC_CHANNELS.COST_GET_HISTORY, {
      instanceId: 'inst-1',
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        instanceId: 'inst-1',
        sessionId: 'sess-1',
      }),
    ]);
  });

  it('accepts the preload COST_GET_HISTORY shape with both arguments omitted', async () => {
    const { tracker } = setup();
    // Zero-cost entries: the tracker persists to the shared test RLM database,
    // so a non-zero spend here would leak into later budget-alert tests.
    tracker.recordUsage('history-a', 'sess-a', 'model', 0, 0, 0, 0, 0);
    tracker.recordUsage('history-b', 'sess-b', 'model', 0, 0, 0, 0, 0);

    // `costGetHistory()` sends `{ instanceId: undefined, limit: undefined }`.
    const result = await invoke(IPC_CHANNELS.COST_GET_HISTORY, { instanceId: undefined, limit: undefined });
    const noPayload = await invoke(IPC_CHANNELS.COST_GET_HISTORY);

    const ids = (response: IpcResponse) =>
      (response.data as { instanceId: string }[]).map((entry) => entry.instanceId);
    expect(result.success).toBe(true);
    expect(ids(result)).toEqual(expect.arrayContaining(['history-a', 'history-b']));
    expect(ids(noPayload)).toEqual(expect.arrayContaining(['history-a', 'history-b']));
  });

  it.each([
    ['a non-object payload', 'inst-1'],
    ['a non-string instanceId', { instanceId: 42 }],
    ['a fractional limit', { limit: 2.5 }],
    ['a zero limit', { limit: 0 }],
    ['a non-numeric limit', { limit: '5' }],
  ])('rejects COST_GET_HISTORY with %s', async (_label, payload) => {
    setup();

    const result = await invoke(IPC_CHANNELS.COST_GET_HISTORY, payload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COST_GET_HISTORY_FAILED');
    expect(result.error?.message).toContain('IPC validation failed for COST_GET_HISTORY');
  });

  it('forwards a recorded turn on cost:usage-recorded (real cost-recorded event)', () => {
    const { tracker, sent } = setup();
    tracker.recordUsage('inst-1', 'sess-1', 'claude-opus-4-8', 100, 200, 0, 0, 0.42);

    const usage = sent.filter((s) => s.channel === 'cost:usage-recorded');
    expect(usage).toHaveLength(1);
    expect((usage[0].data as { instanceId: string; cost: number }).instanceId).toBe('inst-1');
    expect((usage[0].data as { cost: number }).cost).toBe(0.42);
  });

  it('delivers measured and estimated model breakdowns through strict renderer validation', () => {
    const { tracker, sent } = setup();
    const byModel = [{ model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 300, cacheWriteTokens: 400, costUsd: 0.42 }];
    const delivered: unknown[] = [];
    for (const isEstimated of [false, true]) {
      tracker.recordUsage('model-event', 'model-session', 'claude-opus-5-5', 100, 200, 300, 400,
        0.42, 0, isEstimated, { provider: 'claude', byModel });
    }
    for (const event of sent.filter(event => event.channel === IPC_CHANNELS.COST_USAGE_RECORDED)) {
      expect(sendValidatedRendererEvent({ send: (_channel, payload) => delivered.push(payload) },
        event.channel, event.data)).toBe(true);
    }
    expect(delivered).toEqual([expect.objectContaining({ byModel, isEstimated: false }),
      expect.objectContaining({ byModel, isEstimated: true })]);
    expect(tracker.getSessionCost('model-session')).toBe(0.84);
    const valid = delivered[0] as object;
    expect(sendValidatedRendererEvent({ send: vi.fn() }, IPC_CHANNELS.COST_USAGE_RECORDED,
      { ...valid, unrelated: true })).toBe(false);
    expect(sendValidatedRendererEvent({ send: vi.fn() }, IPC_CHANNELS.COST_USAGE_RECORDED,
      { ...valid, byModel: [{ ...byModel[0], costUsd: -1 }] })).toBe(false);
  });

  it('forwards a budget warning (<100%) on cost:budget-warning with a message', () => {
    const { tracker, sent } = setup();
    tracker.setBudget({ enabled: true, perSessionLimit: 5, alertThresholds: [50] });
    // $3 of a $5 session limit = 60% → crosses the 50% threshold, still under limit.
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 3);

    const warnings = sent.filter((s) => s.channel === 'cost:budget-warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const data = warnings[0].data as { message: string; exceeded: boolean; type: string };
    expect(data.exceeded).toBe(false);
    expect(data.type).toBe('session');
    expect(data.message).toContain('session budget at');
    // No exceeded alert should fire while under the limit.
    expect(sent.some((s) => s.channel === 'cost:budget-exceeded')).toBe(false);
  });

  it('forwards an over-limit alert on cost:budget-exceeded', () => {
    const { tracker, sent } = setup();
    tracker.setBudget({ enabled: true, perSessionLimit: 5, alertThresholds: [50, 100] });
    // $10 of a $5 session limit = 200% → over the limit.
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 10);

    const exceeded = sent.filter((s) => s.channel === 'cost:budget-exceeded');
    expect(exceeded.length).toBeGreaterThanOrEqual(1);
    expect((exceeded[0].data as { exceeded: boolean }).exceeded).toBe(true);
  });

  it('does not emit budget alerts when budgeting is disabled (default)', () => {
    const { tracker, sent } = setup();
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 9999);
    expect(sent.some((s) => s.channel.startsWith('cost:budget-'))).toBe(false);
    // usage push still fires.
    expect(sent.some((s) => s.channel === 'cost:usage-recorded')).toBe(true);
  });
});

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
