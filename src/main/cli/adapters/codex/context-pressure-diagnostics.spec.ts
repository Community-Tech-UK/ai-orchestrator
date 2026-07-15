import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

import {
  CodexContextPressureCollector,
  classifyCodexObservedItem,
  type CodexContextDiagnosticRecord,
  type CodexContextDiagnosticSink,
} from './context-pressure-diagnostics';

const SAFE_CORRELATION = 'a1b2c3d4e5f6';

function createHarness(sink?: CodexContextDiagnosticSink) {
  const records: CodexContextDiagnosticRecord[] = [];
  let now = 1_000;
  const collector = new CodexContextPressureCollector(
    sink ?? { write: (record) => records.push(record) },
    () => now++,
  );
  return { collector, records };
}

describe('CodexContextPressureCollector', () => {
  it('numbers usage requests sequentially and records exact last and cumulative deltas', () => {
    const { collector, records } = createHarness();
    collector.startTurn(100);

    collector.recordTokenUsage({
      last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 80, outputTokens: 30, reasoningOutputTokens: 10 },
      total: { totalTokens: 1_000, inputTokens: 900, cachedInputTokens: 700, outputTokens: 100, reasoningOutputTokens: 40 },
      modelContextWindow: 1_000,
    });
    collector.recordTokenUsage({
      last: { totalTokens: 190, inputTokens: 155, cachedInputTokens: 100, outputTokens: 35, reasoningOutputTokens: 12 },
      total: { totalTokens: 1_110, inputTokens: 990, cachedInputTokens: 770, outputTokens: 120, reasoningOutputTokens: 52 },
      modelContextWindow: 1_000,
    });

    const usage = records.filter((record) => record.kind === 'token-usage');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      requestSequence: 1,
      previousLastTotalTokens: 100,
      lastTotalDelta: 50,
      cumulativeTotalDelta: null,
      occupancyPercentage: 15,
    });
    expect(usage[1]).toMatchObject({
      requestSequence: 2,
      previousLastTotalTokens: 150,
      lastTotalDelta: 40,
      cumulativeTotalDelta: 110,
      occupancyPercentage: 19,
    });
  });

  it('preserves absent and malformed numeric fields as null', () => {
    const { collector, records } = createHarness();
    collector.startTurn(Number.NaN);
    collector.recordTokenUsage({
      last: {
        totalTokens: 'not-a-number',
        inputTokens: Number.NaN,
        cachedInputTokens: Number.POSITIVE_INFINITY,
        outputTokens: -1,
      },
      total: null,
      modelContextWindow: {},
    });

    expect(records[0]).toMatchObject({ kind: 'turn-start', baselineUsedTokens: null });
    expect(records[1]).toMatchObject({
      kind: 'token-usage',
      contextWindow: null,
      last: {
        totalTokens: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      },
      cumulative: {
        totalTokens: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      },
      previousLastTotalTokens: null,
      lastTotalDelta: null,
      cumulativeTotalDelta: null,
      occupancyPercentage: null,
    });
  });

  it('separates root and subagent items and resets root payload counters after usage', () => {
    const { collector, records } = createHarness();
    const rootCommand = { type: 'commandExecution', command: 'synthetic-command', aggregatedOutput: 'abc' };
    const subagentTool = { type: 'dynamicToolCall', output: 'subagent-output' };
    const rootMcp = { type: 'mcpToolCall', output: 'xy' };
    collector.startTurn(null);
    collector.recordItemCompleted(rootCommand, true);
    collector.recordItemCompleted(subagentTool, false);
    collector.recordTokenUsage({ last: { totalTokens: 100 }, total: { totalTokens: 500 }, modelContextWindow: 1_000 });
    collector.recordItemCompleted(rootMcp, true);
    collector.recordTokenUsage({ last: { totalTokens: 120 }, total: { totalTokens: 550 }, modelContextWindow: 1_000 });
    collector.completeTurn('completed');

    const items = records.filter((record) => record.kind === 'item-completed');
    expect(items).toEqual([
      expect.objectContaining({ itemSequence: 1, itemClass: 'command', rootThread: true, observedPayloadBytes: 3, serializedItemBytes: Buffer.byteLength(JSON.stringify(rootCommand)) }),
      expect.objectContaining({ itemSequence: 2, itemClass: 'dynamic', rootThread: false, observedPayloadBytes: 15, serializedItemBytes: Buffer.byteLength(JSON.stringify(subagentTool)) }),
      expect.objectContaining({ itemSequence: 3, itemClass: 'mcp', rootThread: true, observedPayloadBytes: 2, serializedItemBytes: Buffer.byteLength(JSON.stringify(rootMcp)) }),
    ]);
    const usage = records.filter((record) => record.kind === 'token-usage');
    expect(usage[0]).toMatchObject({ rootItemsSincePreviousUsage: 1, observedPayloadBytesSincePreviousUsage: 3 });
    expect(usage[1]).toMatchObject({ rootItemsSincePreviousUsage: 1, observedPayloadBytesSincePreviousUsage: 2 });
    expect(records.at(-1)).toMatchObject({
      kind: 'turn-complete',
      rootItems: 2,
      subagentItems: 1,
      observedPayloadBytes: 5,
    });
  });

  it('keeps compaction RPC stages separate from provider-observed compaction', () => {
    const { collector, records } = createHarness();
    collector.startTurn(80);
    collector.recordCompactionRpc('requested');
    collector.recordCompactionRpc('accepted');
    collector.recordCompactionObserved();
    collector.recordCompactionRpc('failed');
    collector.completeTurn('interrupted');

    expect(records.map((record) => record.kind)).toEqual([
      'turn-start',
      'compaction-rpc',
      'compaction-rpc',
      'compaction-observed',
      'compaction-rpc',
      'turn-complete',
    ]);
    expect(records.filter((record) => record.kind === 'compaction-rpc').map((record) => record.stage)).toEqual([
      'requested',
      'accepted',
      'failed',
    ]);
    expect(records.at(-1)).toMatchObject({ kind: 'turn-complete', compactionsObserved: 1 });
  });

  it('records cost-governor decisions and recovery stages without free-form content', () => {
    const { collector, records } = createHarness();
    collector.startTurn(80);
    collector.recordGovernorDecision('recover', 400_000, 100_000, 4);
    collector.recordCostRecovery('interrupt-requested');
    collector.recordCostRecovery('interrupt-observed');
    collector.recordCostRecovery('compaction-observed');
    collector.recordCostRecovery('continued');
    collector.recordCostRecovery('paused', 'compaction-unobserved');

    expect(records.slice(1)).toEqual([
      expect.objectContaining({
        kind: 'cost-governor-decision',
        action: 'recover',
        spendSinceCompaction: 400_000,
        contextWindow: 100_000,
        multiple: 4,
      }),
      expect.objectContaining({ kind: 'cost-recovery', stage: 'interrupt-requested' }),
      expect.objectContaining({ kind: 'cost-recovery', stage: 'interrupt-observed' }),
      expect.objectContaining({ kind: 'cost-recovery', stage: 'compaction-observed' }),
      expect.objectContaining({ kind: 'cost-recovery', stage: 'continued' }),
      expect.objectContaining({ kind: 'cost-recovery', stage: 'paused', reasonCode: 'compaction-unobserved' }),
    ]);
  });

  it('emits transport usage and compaction before routing and ignores other methods', () => {
    const order: string[] = [];
    const collector = new CodexContextPressureCollector(
      { write: (record) => order.push(record.kind) },
      () => 1_000,
    );
    const route = () => order.push('routed');

    collector.recordTransportNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'not-recorded',
        tokenUsage: {
          last: { totalTokens: 12 },
          total: { totalTokens: 34 },
          modelContextWindow: 100,
        },
      },
    }, SAFE_CORRELATION);
    route();
    collector.recordTransportNotification({
      method: 'thread/compacted',
      params: { threadId: 'not-recorded' },
    }, SAFE_CORRELATION);
    route();
    collector.recordTransportNotification({ method: 'item/completed', params: {} }, SAFE_CORRELATION);
    route();

    expect(order).toEqual(['transport-usage', 'routed', 'transport-compaction', 'routed', 'routed']);
  });

  it('resets all per-turn counters and baselines for a fresh turn', () => {
    const { collector, records } = createHarness();
    collector.startTurn(10);
    collector.recordItemCompleted({ type: 'command_execution', output: 'first' }, true);
    collector.recordTokenUsage({ last: { totalTokens: 20 }, total: { totalTokens: 100 }, modelContextWindow: 200 });
    collector.completeTurn('completed');

    collector.startTurn(5);
    collector.recordItemCompleted({ type: 'webSearch', output: 'next' }, false);
    collector.recordTokenUsage({ last: { totalTokens: 8 }, total: { totalTokens: 20 }, modelContextWindow: 40 });
    collector.completeTurn('failed');

    const secondStart = records.findLast((record) => record.kind === 'turn-start');
    const secondItem = records.findLast((record) => record.kind === 'item-completed');
    const secondUsage = records.findLast((record) => record.kind === 'token-usage');
    const secondComplete = records.findLast((record) => record.kind === 'turn-complete');
    expect(secondStart).toMatchObject({ turnSequence: 2, baselineUsedTokens: 5 });
    expect(secondItem).toMatchObject({ turnSequence: 2, itemSequence: 1 });
    expect(secondUsage).toMatchObject({
      turnSequence: 2,
      requestSequence: 1,
      previousLastTotalTokens: 5,
      lastTotalDelta: 3,
      cumulativeTotalDelta: null,
    });
    expect(secondComplete).toMatchObject({
      turnSequence: 2,
      requestSequence: 1,
      rootItems: 0,
      subagentItems: 1,
      completionStatus: 'failed',
    });
  });

  it('isolates sink failures from collection and transport routing', () => {
    const records: CodexContextDiagnosticRecord[] = [];
    const write = vi.fn((record: CodexContextDiagnosticRecord) => {
      if (write.mock.calls.length === 1) throw new Error('synthetic sink failure');
      records.push(record);
    });
    const collector = new CodexContextPressureCollector({ write }, () => 1_000);

    expect(() => collector.startTurn(10)).not.toThrow();
    expect(() => collector.recordTokenUsage({ last: { totalTokens: 15 }, total: { totalTokens: 20 } })).not.toThrow();
    expect(records).toEqual([expect.objectContaining({ kind: 'token-usage', turnSequence: 1, requestSequence: 1 })]);
  });

  it('uses a safe timestamp when the injected clock throws', () => {
    const records: CodexContextDiagnosticRecord[] = [];
    const collector = new CodexContextPressureCollector(
      { write: (record) => records.push(record) },
      () => { throw new Error('synthetic clock failure'); },
    );

    expect(() => {
      collector.startTurn(10);
      collector.recordTokenUsage({ last: { totalTokens: 15 }, total: { totalTokens: 20 } });
    }).not.toThrow();
    expect(records.map((record) => record.at)).toEqual([0, 0]);
  });

  it('uses a safe timestamp for every non-finite clock result', () => {
    const records: CodexContextDiagnosticRecord[] = [];
    const nonFiniteTimestamps = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const collector = new CodexContextPressureCollector(
      { write: (record) => records.push(record) },
      () => nonFiniteTimestamps.shift() ?? 1_000,
    );

    expect(() => {
      collector.startTurn(10);
      collector.recordCompactionRpc('requested');
      collector.completeTurn('completed');
    }).not.toThrow();
    expect(records.map((record) => record.at)).toEqual([0, 0, 0]);
  });

  it('classifies items by bounded class without exposing tool names or commands', () => {
    expect([
      'command_execution', 'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
      'file_change', 'fileChange', 'collabAgentToolCall', 'agent_message', 'agentMessage', 'reasoning', 'unknown',
    ].map((type) => classifyCodexObservedItem({ type, command: 'not-recorded', tool: 'not-recorded' }))).toEqual([
      'command', 'command', 'mcp', 'dynamic', 'web', 'file-change', 'file-change', 'collaboration',
      'agent-message', 'agent-message', 'reasoning', 'other',
    ]);
  });

  it('caps wide plain-object traversal and returns the exact bounded serialized byte count', () => {
    const { collector, records } = createHarness();
    const wideItem: Record<string, unknown> = { type: 'unknown' };
    const expectedBoundedItem: Record<string, unknown> = { type: 'unknown' };
    let propertyReads = 0;
    for (let index = 0; index < 10_050; index += 1) {
      Object.defineProperty(wideItem, `field${index}`, {
        enumerable: true,
        get: () => {
          propertyReads += 1;
          return index;
        },
      });
      if (index < 9_999) expectedBoundedItem[`field${index}`] = index;
    }

    collector.startTurn(null);
    collector.recordItemCompleted(wideItem, true);

    const itemRecord = records.find((record) => record.kind === 'item-completed');
    expect(itemRecord).toMatchObject({
      serializedItemBytes: Buffer.byteLength(JSON.stringify(expectedBoundedItem)),
    });
    expect(propertyReads).toBe(9_999);
  });

  it('emits schema records that cannot carry content-bearing keys or measured values', () => {
    const { collector, records } = createHarness();
    const sensitiveMarker = 'SYNTHETIC_SENSITIVE_MARKER';
    const homePath = '/home/example-user/private-project';
    collector.recordTransportNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: `${sensitiveMarker}-thread`,
        tokenUsage: { last: { totalTokens: 11 }, total: { totalTokens: 22 }, modelContextWindow: 100 },
      },
    }, SAFE_CORRELATION);
    collector.recordTransportNotification({
      method: 'thread/compacted',
      params: { threadId: `${sensitiveMarker}-thread` },
    }, SAFE_CORRELATION);
    collector.startTurn(10);
    collector.recordItemCompleted({
      type: 'commandExecution',
      command: sensitiveMarker,
      aggregatedOutput: `${sensitiveMarker}:${homePath}`,
      input: { path: homePath, query: sensitiveMarker },
      environment: { SYNTHETIC_PASSWORD: sensitiveMarker },
      credentials: { apiKey: sensitiveMarker, password: sensitiveMarker },
    }, true);
    collector.recordTokenUsage({
      last: { totalTokens: 20, inputTokens: 18, outputTokens: 2 },
      total: { totalTokens: 30, inputTokens: 27, outputTokens: 3 },
      modelContextWindow: 100,
      content: sensitiveMarker,
    });
    collector.recordCompactionRpc('requested');
    collector.recordCompactionObserved();
    collector.completeTurn('completed');

    const forbiddenFragments = [
      'prompt', 'message', 'command', 'query', 'path', 'url', 'input', 'output', 'content', 'payload',
      'threadid', 'turnid', 'itemid', 'sessionid', 'secret', 'token', 'environment', 'env',
      'credential', 'password', 'passwd', 'apikey', 'api_key', 'authorization', 'auth', 'cookie',
      'header', 'privatekey', 'private_key',
    ];
    const allowedSensitiveKeys = new Set([
      'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
      'baselineUsedTokens', 'previousLastTotalTokens', 'lastTotalDelta', 'cumulativeTotalDelta',
      'lastKnownUsedTokens', 'peakUsedTokens', 'observedPayloadBytes',
      'observedPayloadBytesSincePreviousUsage',
    ]);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        const lowered = key.toLowerCase();
        const forbidden = forbiddenFragments.some((fragment) => lowered.includes(fragment));
        expect(forbidden && !allowedSensitiveKeys.has(key), `content-bearing diagnostic key: ${key}`).toBe(false);
        walk(nested);
      }
    };
    records.forEach(walk);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(sensitiveMarker);
    expect(serialized).not.toContain(homePath);
  });
});
