import { Buffer } from 'node:buffer';

export type CodexObservedItemClass =
  | 'command'
  | 'mcp'
  | 'dynamic'
  | 'web'
  | 'file-change'
  | 'collaboration'
  | 'agent-message'
  | 'reasoning'
  | 'other';

export interface CodexTokenUsageSnapshot {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export type CodexContextDiagnosticRecord =
  | { kind: 'transport-usage'; schemaVersion: 1; at: number; transportSequence: number; threadCorrelation: string; contextWindow: number | null; last: CodexTokenUsageSnapshot; cumulative: CodexTokenUsageSnapshot }
  | { kind: 'transport-compaction'; schemaVersion: 1; at: number; transportSequence: number; threadCorrelation: string }
  | { kind: 'turn-start'; schemaVersion: 1; at: number; turnSequence: number; baselineUsedTokens: number | null }
  | { kind: 'item-completed'; schemaVersion: 1; at: number; turnSequence: number; itemSequence: number; itemClass: CodexObservedItemClass; rootThread: boolean; observedPayloadBytes: number; serializedItemBytes: number }
  | { kind: 'token-usage'; schemaVersion: 1; at: number; turnSequence: number; requestSequence: number; contextWindow: number | null; last: CodexTokenUsageSnapshot; cumulative: CodexTokenUsageSnapshot; previousLastTotalTokens: number | null; lastTotalDelta: number | null; cumulativeTotalDelta: number | null; occupancyPercentage: number | null; rootItemsSincePreviousUsage: number; observedPayloadBytesSincePreviousUsage: number }
  | { kind: 'compaction-rpc'; schemaVersion: 1; at: number; turnSequence: number | null; stage: 'requested' | 'accepted' | 'failed'; lastKnownUsedTokens: number | null }
  | { kind: 'compaction-observed'; schemaVersion: 1; at: number; turnSequence: number | null; requestSequence: number | null; lastKnownUsedTokens: number | null }
  | { kind: 'turn-complete'; schemaVersion: 1; at: number; turnSequence: number; requestSequence: number; rootItems: number; subagentItems: number; observedPayloadBytes: number; peakUsedTokens: number | null; peakPercentage: number | null; compactionsObserved: number; completionStatus: 'completed' | 'interrupted' | 'failed' | 'unknown' };

export interface CodexContextDiagnosticSink {
  write(record: CodexContextDiagnosticRecord): void;
}

type CodexCompletionStatus = Extract<CodexContextDiagnosticRecord, { kind: 'turn-complete' }>['completionStatus'];
type CodexCompactionRpcStage = Extract<CodexContextDiagnosticRecord, { kind: 'compaction-rpc' }>['stage'];
type Clock = () => number;

const MAX_SERIALIZED_STRING_CHARS = 4 * 1024 * 1024;
const MAX_SERIALIZED_COLLECTION_ENTRIES = 10_000;
const MAX_SERIALIZED_DEPTH = 100;
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;
const SAFE_CORRELATION_PATTERN = /^[a-f0-9]{12}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readField(record: Record<string, unknown> | null, camelCase: string, snakeCase: string): number | null {
  return numericCount(record?.[camelCase] ?? record?.[snakeCase]);
}

function readSnapshot(value: unknown): CodexTokenUsageSnapshot {
  const record = asRecord(value);
  return {
    totalTokens: readField(record, 'totalTokens', 'total_tokens'),
    inputTokens: readField(record, 'inputTokens', 'input_tokens'),
    cachedInputTokens: readField(record, 'cachedInputTokens', 'cached_input_tokens'),
    outputTokens: readField(record, 'outputTokens', 'output_tokens'),
    reasoningOutputTokens: readField(record, 'reasoningOutputTokens', 'reasoning_output_tokens'),
  };
}

function readUsage(value: unknown): {
  contextWindow: number | null;
  cumulative: CodexTokenUsageSnapshot;
  last: CodexTokenUsageSnapshot;
} {
  const usage = asRecord(value);
  return {
    contextWindow: readField(usage, 'modelContextWindow', 'model_context_window'),
    last: readSnapshot(usage?.['last'] ?? usage?.['last_token_usage']),
    cumulative: readSnapshot(usage?.['total'] ?? usage?.['total_token_usage']),
  };
}

interface SerializationBudget {
  remainingEntries: number;
  readonly seen: WeakSet<object>;
}

function boundedByteSum(...sizes: number[]): number {
  let total = 0;
  for (const size of sizes) {
    total += size;
    if (total >= MAX_SERIALIZED_BYTES) return MAX_SERIALIZED_BYTES;
  }
  return total;
}

function jsonStringByteLength(value: string): number {
  const boundedValue = value.length > MAX_SERIALIZED_STRING_CHARS
    ? value.slice(0, MAX_SERIALIZED_STRING_CHARS)
    : value;
  return Math.min(Buffer.byteLength(JSON.stringify(boundedValue)), MAX_SERIALIZED_BYTES);
}

function boundedJsonByteLength(
  value: unknown,
  budget: SerializationBudget,
  depth = 0,
): number | undefined {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringByteLength(value);
  if (typeof value === 'number') return Buffer.byteLength(JSON.stringify(value));
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'bigint') throw new TypeError('Cannot serialize BigInt');
  if (typeof value !== 'object') return undefined;
  if (budget.seen.has(value) || depth >= MAX_SERIALIZED_DEPTH) return 4;
  budget.seen.add(value);

  if (Array.isArray(value)) {
    let bytes = 2;
    let emittedEntries = 0;
    for (let index = 0; index < value.length && budget.remainingEntries > 0; index += 1) {
      budget.remainingEntries -= 1;
      const nestedBytes = boundedJsonByteLength(value[index], budget, depth + 1) ?? 4;
      bytes = boundedByteSum(bytes, emittedEntries > 0 ? 1 : 0, nestedBytes);
      emittedEntries += 1;
      if (bytes === MAX_SERIALIZED_BYTES) return bytes;
    }
    return bytes;
  }

  let bytes = 2;
  let emittedProperties = 0;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (budget.remainingEntries <= 0) break;
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    budget.remainingEntries -= 1;
    const nestedBytes = boundedJsonByteLength(record[key], budget, depth + 1);
    if (nestedBytes === undefined) continue;
    bytes = boundedByteSum(
      bytes,
      emittedProperties > 0 ? 1 : 0,
      jsonStringByteLength(key),
      1,
      nestedBytes,
    );
    emittedProperties += 1;
    if (bytes === MAX_SERIALIZED_BYTES) return bytes;
  }
  return bytes;
}

function byteLengthOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return boundedJsonByteLength(value, {
      remainingEntries: MAX_SERIALIZED_COLLECTION_ENTRIES,
      seen: new WeakSet<object>(),
    }) ?? 0;
  } catch {
    return 0;
  }
}

export function classifyCodexObservedItem(value: unknown): CodexObservedItemClass {
  const type = asRecord(value)?.['type'];
  switch (type) {
    case 'command_execution':
    case 'commandExecution':
      return 'command';
    case 'mcpToolCall':
    case 'mcp_tool_call':
      return 'mcp';
    case 'dynamicToolCall':
    case 'dynamic_tool_call':
      return 'dynamic';
    case 'webSearch':
    case 'web_search':
      return 'web';
    case 'file_change':
    case 'fileChange':
      return 'file-change';
    case 'collabAgentToolCall':
    case 'collab_agent_tool_call':
      return 'collaboration';
    case 'agent_message':
    case 'agentMessage':
      return 'agent-message';
    case 'reasoning':
      return 'reasoning';
    default:
      return 'other';
  }
}

export class CodexContextPressureCollector {
  private transportSequence = 0;
  private turnSequence = 0;
  private turnActive = false;
  private requestSequence = 0;
  private itemSequence = 0;
  private rootItems = 0;
  private subagentItems = 0;
  private rootItemsSincePreviousUsage = 0;
  private observedPayloadBytes = 0;
  private observedPayloadBytesSincePreviousUsage = 0;
  private previousLastTotalTokens: number | null = null;
  private previousCumulativeTotalTokens: number | null = null;
  private peakUsedTokens: number | null = null;
  private peakPercentage: number | null = null;
  private compactionsObserved = 0;

  constructor(
    private readonly sink: CodexContextDiagnosticSink,
    private readonly clock: Clock = Date.now,
  ) {}

  recordTransportNotification(notificationValue: unknown, threadCorrelationValue: string): void {
    const notification = asRecord(notificationValue);
    const method = notification?.['method'];
    if (method !== 'thread/tokenUsage/updated' && method !== 'thread/compacted') return;

    const threadCorrelation = SAFE_CORRELATION_PATTERN.test(threadCorrelationValue)
      ? threadCorrelationValue
      : 'unavailable';
    this.transportSequence += 1;
    if (method === 'thread/compacted') {
      this.write({
        kind: 'transport-compaction',
        schemaVersion: 1,
        at: this.now(),
        transportSequence: this.transportSequence,
        threadCorrelation,
      });
      return;
    }

    const params = asRecord(notification?.['params']);
    const usage = readUsage(params?.['tokenUsage'] ?? params?.['token_usage']);
    this.write({
      kind: 'transport-usage',
      schemaVersion: 1,
      at: this.now(),
      transportSequence: this.transportSequence,
      threadCorrelation,
      ...usage,
    });
  }

  startTurn(baselineUsedTokensValue: unknown): void {
    this.turnSequence += 1;
    this.turnActive = true;
    this.requestSequence = 0;
    this.itemSequence = 0;
    this.rootItems = 0;
    this.subagentItems = 0;
    this.rootItemsSincePreviousUsage = 0;
    this.observedPayloadBytes = 0;
    this.observedPayloadBytesSincePreviousUsage = 0;
    this.previousLastTotalTokens = numericCount(baselineUsedTokensValue);
    this.previousCumulativeTotalTokens = null;
    this.peakUsedTokens = null;
    this.peakPercentage = null;
    this.compactionsObserved = 0;
    this.write({
      kind: 'turn-start',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnSequence,
      baselineUsedTokens: this.previousLastTotalTokens,
    });
  }

  recordItemCompleted(itemValue: unknown, rootThread: boolean): void {
    if (!this.turnActive) return;
    const item = asRecord(itemValue);
    const observedPayloadBytes = byteLengthOf(
      item?.['aggregatedOutput']
      ?? item?.['aggregated_output']
      ?? item?.['output']
      ?? item?.['content']
      ?? item?.['text']
      ?? item?.['description'],
    );
    const serializedItemBytes = byteLengthOf(itemValue);
    this.itemSequence += 1;
    if (rootThread) {
      this.rootItems += 1;
      this.rootItemsSincePreviousUsage += 1;
      this.observedPayloadBytes += observedPayloadBytes;
      this.observedPayloadBytesSincePreviousUsage += observedPayloadBytes;
    } else {
      this.subagentItems += 1;
    }
    this.write({
      kind: 'item-completed',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnSequence,
      itemSequence: this.itemSequence,
      itemClass: classifyCodexObservedItem(itemValue),
      rootThread,
      observedPayloadBytes,
      serializedItemBytes,
    });
  }

  recordTokenUsage(usageValue: unknown): void {
    if (!this.turnActive) return;
    const usage = readUsage(usageValue);
    this.requestSequence += 1;
    const previousLastTotalTokens = this.previousLastTotalTokens;
    const lastTotalDelta = usage.last.totalTokens !== null && previousLastTotalTokens !== null
      ? usage.last.totalTokens - previousLastTotalTokens
      : null;
    const cumulativeTotalDelta = usage.cumulative.totalTokens !== null && this.previousCumulativeTotalTokens !== null
      ? usage.cumulative.totalTokens - this.previousCumulativeTotalTokens
      : null;
    const occupancyPercentage = usage.last.totalTokens !== null && usage.contextWindow !== null && usage.contextWindow > 0
      ? (usage.last.totalTokens / usage.contextWindow) * 100
      : null;
    this.write({
      kind: 'token-usage',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnSequence,
      requestSequence: this.requestSequence,
      ...usage,
      previousLastTotalTokens,
      lastTotalDelta,
      cumulativeTotalDelta,
      occupancyPercentage,
      rootItemsSincePreviousUsage: this.rootItemsSincePreviousUsage,
      observedPayloadBytesSincePreviousUsage: this.observedPayloadBytesSincePreviousUsage,
    });
    if (usage.last.totalTokens !== null) {
      this.previousLastTotalTokens = usage.last.totalTokens;
      this.peakUsedTokens = this.peakUsedTokens === null
        ? usage.last.totalTokens
        : Math.max(this.peakUsedTokens, usage.last.totalTokens);
    }
    if (usage.cumulative.totalTokens !== null) {
      this.previousCumulativeTotalTokens = usage.cumulative.totalTokens;
    }
    if (occupancyPercentage !== null) {
      this.peakPercentage = this.peakPercentage === null
        ? occupancyPercentage
        : Math.max(this.peakPercentage, occupancyPercentage);
    }
    this.rootItemsSincePreviousUsage = 0;
    this.observedPayloadBytesSincePreviousUsage = 0;
  }

  recordCompactionRpc(stage: CodexCompactionRpcStage): void {
    this.write({
      kind: 'compaction-rpc',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnActive ? this.turnSequence : null,
      stage,
      lastKnownUsedTokens: this.previousLastTotalTokens,
    });
  }

  recordCompactionObserved(): void {
    if (this.turnActive) this.compactionsObserved += 1;
    this.write({
      kind: 'compaction-observed',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnActive ? this.turnSequence : null,
      requestSequence: this.turnActive && this.requestSequence > 0 ? this.requestSequence : null,
      lastKnownUsedTokens: this.previousLastTotalTokens,
    });
  }

  completeTurn(completionStatus: CodexCompletionStatus): void {
    if (!this.turnActive) return;
    this.write({
      kind: 'turn-complete',
      schemaVersion: 1,
      at: this.now(),
      turnSequence: this.turnSequence,
      requestSequence: this.requestSequence,
      rootItems: this.rootItems,
      subagentItems: this.subagentItems,
      observedPayloadBytes: this.observedPayloadBytes,
      peakUsedTokens: this.peakUsedTokens,
      peakPercentage: this.peakPercentage,
      compactionsObserved: this.compactionsObserved,
      completionStatus,
    });
    this.turnActive = false;
  }

  private now(): number {
    try {
      const value = this.clock();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private write(record: CodexContextDiagnosticRecord): void {
    try {
      this.sink.write(record);
    } catch {
      // Diagnostic collection must never affect provider routing or turn state.
    }
  }
}
