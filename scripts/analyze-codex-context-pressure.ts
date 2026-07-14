#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import {
  createReadStream, existsSync, mkdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type DiagnosticKind =
  | 'transport-usage'
  | 'transport-compaction'
  | 'turn-start'
  | 'item-completed'
  | 'token-usage'
  | 'compaction-rpc'
  | 'compaction-observed'
  | 'turn-complete';

type ProviderEventKind =
  | 'output'
  | 'tool-use'
  | 'tool-result'
  | 'status'
  | 'context'
  | 'error'
  | 'exit'
  | 'spawned'
  | 'complete'
  | 'other';

type RolloutEntryType =
  | 'session-metadata'
  | 'response-item'
  | 'event-message'
  | 'turn-context'
  | 'compaction'
  | 'other';

type RolloutSubtype =
  | 'token-count'
  | 'compaction'
  | 'message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'web-search'
  | 'file-change'
  | 'turn-start'
  | 'turn-complete'
  | 'other';

type ItemClass =
  | 'command'
  | 'mcp'
  | 'dynamic'
  | 'web'
  | 'file-change'
  | 'collaboration'
  | 'agent-message'
  | 'reasoning'
  | 'other';

type LimitationCode =
  | 'diagnostic-log-not-supplied'
  | 'provider-captures-not-supplied'
  | 'provider-capture-table-unavailable'
  | 'rollout-not-supplied'
  | 'raw-diagnostic-usage-unavailable'
  | 'normalized-context-events-unavailable'
  | 'rollout-token-count-events-unavailable'
  | 'item-size-observations-unavailable'
  | 'compaction-markers-unavailable'
  | 'turn-boundaries-unavailable';

interface SourceSummary {
  provided: boolean;
  available: boolean;
  acceptedRecords: number;
  malformedRecords: number;
}

interface TokenSnapshot {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

interface AnalysisTimelineEvent {
  source: 'diagnostic' | 'provider-capture' | 'rollout';
  at: number | null;
  sequence: number;
  kind?: DiagnosticKind | ProviderEventKind;
  entryType?: RolloutEntryType;
  subtype?: RolloutSubtype;
  [key: string]: unknown;
}

export interface CodexContextAnalysisSummary {
  schemaVersion: 1;
  sources: {
    diagnosticLog: SourceSummary;
    providerCaptures: SourceSummary;
    rollout: SourceSummary;
  };
  counts: {
    timelineEvents: number;
    diagnosticKinds: Record<DiagnosticKind, number>;
    providerEventKinds: Record<ProviderEventKind, number>;
    rolloutEntryTypes: Record<RolloutEntryType, number>;
  };
  coverage: {
    rawDiagnosticUsageNotifications: boolean;
    normalizedContextEvents: boolean;
    rolloutTokenCountEvents: boolean;
    itemSizeObservations: boolean;
    compactionMarkers: boolean;
    turnBoundaries: boolean;
  };
  limitations: LimitationCode[];
}

export interface CodexContextAnalysisOptions {
  logPath?: string;
  dbPath?: string;
  instanceId?: string;
  rolloutPath?: string;
  outDir: string;
}

export interface CodexContextAnalysisFiles {
  summaryPath: string;
  timelinePath: string;
  reportPath: string;
}

interface AnalysisState {
  summary: CodexContextAnalysisSummary;
  timeline: AnalysisTimelineEvent[];
}

interface CaptureRow {
  sequence: number;
  created_at: number;
  event_json: string;
  raw_provenance_present: number;
}

interface ReadonlyCaptureDatabase {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    iterate(...values: unknown[]): Iterable<unknown>;
  };
  close(): void;
}

export interface CodexContextAnalysisDependencies {
  openDatabase(path: string, options: { readonly: true; fileMustExist: true }): ReadonlyCaptureDatabase;
}

const DEFAULT_DEPENDENCIES: CodexContextAnalysisDependencies = {
  openDatabase: openDefaultDatabase,
};

function openDefaultDatabase(
  path: string,
  options: { readonly: true; fileMustExist: true },
): ReadonlyCaptureDatabase {
  statSync(path);
  try {
    return new Database(path, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('NODE_MODULE_VERSION')
      && !message.includes('compiled against a different Node.js version')) throw error;
    return new DatabaseSync(path, { readOnly: true }) as unknown as ReadonlyCaptureDatabase;
  }
}

const DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = [
  'transport-usage', 'transport-compaction', 'turn-start', 'item-completed',
  'token-usage', 'compaction-rpc', 'compaction-observed', 'turn-complete',
];

const PROVIDER_EVENT_KINDS: readonly ProviderEventKind[] = [
  'output', 'tool-use', 'tool-result', 'status', 'context', 'error', 'exit',
  'spawned', 'complete', 'other',
];

const ROLLOUT_ENTRY_TYPES: readonly RolloutEntryType[] = [
  'session-metadata', 'response-item', 'event-message', 'turn-context', 'compaction', 'other',
];

const ITEM_CLASSES = new Set<ItemClass>([
  'command', 'mcp', 'dynamic', 'web', 'file-change', 'collaboration',
  'agent-message', 'reasoning', 'other',
]);

const CONTENT_KEYS = new Set([
  'content', 'text', 'message', 'prompt', 'instructions', 'command', 'args',
  'arguments', 'input', 'output', 'result', 'query', 'url', 'path', 'cwd',
]);

const MAX_CALL_CLASS_CORRELATIONS = 1_000;

export async function analyzeCodexContextPressure(
  options: CodexContextAnalysisOptions,
  dependencies: CodexContextAnalysisDependencies = DEFAULT_DEPENDENCIES,
): Promise<CodexContextAnalysisFiles> {
  validateOptions(options);
  const state = createState(options);
  if (options.logPath) await parseDiagnosticLog(resolve(options.logPath), state);
  if (options.dbPath && options.instanceId) {
    parseProviderCaptures(resolve(options.dbPath), options.instanceId, state, dependencies);
  }
  if (options.rolloutPath) await parseRollout(resolve(options.rolloutPath), state);

  state.timeline.sort(compareTimelineEvents);
  state.summary.counts.timelineEvents = state.timeline.length;
  state.summary.limitations = buildLimitations(state.summary);

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const files = {
    summaryPath: join(outDir, 'summary.json'),
    timelinePath: join(outDir, 'timeline.jsonl'),
    reportPath: join(outDir, 'report.md'),
  };
  writeFileSync(files.summaryPath, `${JSON.stringify(state.summary, null, 2)}\n`, 'utf8');
  writeFileSync(files.timelinePath, toJsonLines(state.timeline), 'utf8');
  writeFileSync(files.reportPath, buildReport(state.summary, state.timeline), 'utf8');
  return files;
}

function validateOptions(options: CodexContextAnalysisOptions): void {
  if (!options.logPath && !options.dbPath && !options.rolloutPath) {
    throw new Error('At least one evidence source is required');
  }
  if (options.dbPath && !options.instanceId) throw new Error('--instance is required with --db');
  if (options.instanceId && !options.dbPath) throw new Error('--db is required with --instance');
  const outDir = canonicalPath(options.outDir);
  const inputDirectories = [options.logPath, options.dbPath, options.rolloutPath]
    .filter((value): value is string => Boolean(value))
    .map((value) => dirname(canonicalPath(value)));
  if (inputDirectories.some((directory) => pathContains(directory, outDir))) {
    throw new Error('Output directory must not be equal to or nested within an input directory');
  }
}

function canonicalPath(value: string): string {
  let cursor = resolve(value);
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(value);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missingSegments);
}

function pathContains(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(relation));
}

function createState(options: CodexContextAnalysisOptions): AnalysisState {
  const source = (provided: boolean): SourceSummary => ({
    provided, available: provided, acceptedRecords: 0, malformedRecords: 0,
  });
  return {
    timeline: [],
    summary: {
      schemaVersion: 1,
      sources: {
        diagnosticLog: source(Boolean(options.logPath)),
        providerCaptures: source(Boolean(options.dbPath)),
        rollout: source(Boolean(options.rolloutPath)),
      },
      counts: {
        timelineEvents: 0,
        diagnosticKinds: zeroCounts(DIAGNOSTIC_KINDS),
        providerEventKinds: zeroCounts(PROVIDER_EVENT_KINDS),
        rolloutEntryTypes: zeroCounts(ROLLOUT_ENTRY_TYPES),
      },
      coverage: {
        rawDiagnosticUsageNotifications: false,
        normalizedContextEvents: false,
        rolloutTokenCountEvents: false,
        itemSizeObservations: false,
        compactionMarkers: false,
        turnBoundaries: false,
      },
      limitations: [],
    },
  };
}

async function parseDiagnosticLog(path: string, state: AnalysisState): Promise<void> {
  let lineNumber = 0;
  await forEachLine(path, (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      state.summary.sources.diagnosticLog.malformedRecords += 1;
      return;
    }
    const entry = asRecord(parsed);
    if (entry?.['subsystem'] !== 'CodexContextDiagnostics'
      || entry['message'] !== 'context-pressure-observation') return;
    const event = sanitizeDiagnosticRecord(entry['data'], lineNumber);
    if (!event) {
      state.summary.sources.diagnosticLog.malformedRecords += 1;
      return;
    }
    state.timeline.push(event);
    state.summary.sources.diagnosticLog.acceptedRecords += 1;
    const kind = event.kind as DiagnosticKind;
    state.summary.counts.diagnosticKinds[kind] += 1;
    updateDiagnosticCoverage(kind, state.summary);
  });
}

function sanitizeDiagnosticRecord(value: unknown, sequence: number): AnalysisTimelineEvent | null {
  const data = asRecord(value);
  const kind = data?.['kind'];
  if (data?.['schemaVersion'] !== 1 || !isOneOf(kind, DIAGNOSTIC_KINDS)) return null;
  const at = finiteNumber(data['at']);
  if (at === null) return null;
  const base: AnalysisTimelineEvent = { source: 'diagnostic', at, sequence, kind };
  switch (kind) {
    case 'transport-usage':
      if (!validNumbers(data, ['transportSequence'], ['contextWindow']) || !validUsage(data)) return null;
      return withUsage(base, data, ['transportSequence', 'contextWindow']);
    case 'transport-compaction':
      if (!validNumbers(data, ['transportSequence'])) return null;
      return withNumbers(base, data, ['transportSequence']);
    case 'turn-start':
      if (!validNumbers(data, ['turnSequence'], ['baselineUsedTokens'])) return null;
      return withNumbers(base, data, ['turnSequence', 'baselineUsedTokens']);
    case 'item-completed': {
      const itemClass = data['itemClass'];
      if (!ITEM_CLASSES.has(itemClass as ItemClass)
        || typeof data['rootThread'] !== 'boolean'
        || !validNumbers(data, [
          'turnSequence', 'itemSequence', 'observedPayloadBytes', 'serializedItemBytes',
        ])) return null;
      return {
        ...withNumbers(base, data, [
          'turnSequence', 'itemSequence', 'observedPayloadBytes', 'serializedItemBytes',
        ]),
        itemClass,
        rootThread: data['rootThread'],
      };
    }
    case 'token-usage':
      if (!validNumbers(
        data,
        ['turnSequence', 'requestSequence', 'rootItemsSincePreviousUsage', 'observedPayloadBytesSincePreviousUsage'],
        ['contextWindow', 'previousLastTotalTokens', 'lastTotalDelta', 'cumulativeTotalDelta', 'occupancyPercentage'],
      ) || !validUsage(data)) return null;
      return withUsage(withNumbers(base, data, [
        'turnSequence', 'requestSequence', 'previousLastTotalTokens', 'lastTotalDelta',
        'cumulativeTotalDelta', 'occupancyPercentage', 'rootItemsSincePreviousUsage',
        'observedPayloadBytesSincePreviousUsage',
      ]), data, ['contextWindow']);
    case 'compaction-rpc': {
      const stage = data['stage'];
      if (!isOneOf(stage, ['requested', 'accepted', 'failed'] as const)
        || !validNumbers(data, [], ['turnSequence', 'lastKnownUsedTokens'])) return null;
      return { ...withNumbers(base, data, ['turnSequence', 'lastKnownUsedTokens']), stage };
    }
    case 'compaction-observed':
      if (!validNumbers(data, [], ['turnSequence', 'requestSequence', 'lastKnownUsedTokens'])) return null;
      return withNumbers(base, data, ['turnSequence', 'requestSequence', 'lastKnownUsedTokens']);
    case 'turn-complete': {
      const completionStatus = data['completionStatus'];
      if (!isOneOf(completionStatus, ['completed', 'interrupted', 'failed', 'unknown'] as const)
        || !validNumbers(
          data,
          ['turnSequence', 'requestSequence', 'rootItems', 'subagentItems', 'observedPayloadBytes', 'compactionsObserved'],
          ['peakUsedTokens', 'peakPercentage'],
        )) return null;
      return {
        ...withNumbers(base, data, [
          'turnSequence', 'requestSequence', 'rootItems', 'subagentItems',
          'observedPayloadBytes', 'peakUsedTokens', 'peakPercentage', 'compactionsObserved',
        ]),
        completionStatus,
      };
    }
  }
}

function parseProviderCaptures(
  path: string,
  instanceId: string,
  state: AnalysisState,
  dependencies: CodexContextAnalysisDependencies,
): void {
  const db = dependencies.openDatabase(path, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_event_captures'
    `).get();
    if (!tableExists) {
      state.summary.sources.providerCaptures.available = false;
      return;
    }
    const rows = db.prepare(`
      SELECT sequence, created_at, event_json,
             CASE WHEN length(raw_source) > 0 AND length(raw_json) > 0 THEN 1 ELSE 0 END
               AS raw_provenance_present
      FROM provider_event_captures
      WHERE instance_id = ?
      ORDER BY created_at ASC, sequence ASC
    `).iterate(instanceId) as Iterable<CaptureRow>;
    for (const row of rows) {
      const event = parseProviderEvent(row);
      if (!event) {
        state.summary.sources.providerCaptures.malformedRecords += 1;
        continue;
      }
      state.timeline.push(event);
      state.summary.sources.providerCaptures.acceptedRecords += 1;
      const kind = event.kind as ProviderEventKind;
      state.summary.counts.providerEventKinds[kind] += 1;
      if (kind === 'context') state.summary.coverage.normalizedContextEvents = true;
    }
  } finally {
    db.close();
  }
}

function parseProviderEvent(row: CaptureRow): AnalysisTimelineEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json) as unknown;
  } catch {
    return null;
  }
  const event = asRecord(parsed);
  if (!event || finiteNumber(row.created_at) === null || finiteNumber(row.sequence) === null) return null;
  const kind = normalizeProviderKind(event['kind']);
  const output: AnalysisTimelineEvent = {
    source: 'provider-capture', at: row.created_at, sequence: row.sequence, kind,
    rawProvenancePresent: row.raw_provenance_present === 1,
  };
  if (kind === 'output') output['contentBytes'] = valueByteLength(event['content']);
  if (kind === 'tool-result') output['contentBytes'] = valueByteLength(event['output']);
  if (kind === 'status') output['statusClass'] = normalizeStatus(event['status']);
  if (kind === 'context') {
    copyNumeric(output, event, 'used', 'usedTokens');
    copyNumeric(output, event, 'total', 'contextWindow');
    copyNumeric(output, event, 'percentage', 'occupancyPercentage');
    copyNumeric(output, event, 'inputTokens', 'inputTokens');
    copyNumeric(output, event, 'outputTokens', 'outputTokens');
    copyNumeric(output, event, 'promptWeight', 'inputShareRatio');
  }
  return output;
}

async function parseRollout(path: string, state: AnalysisState): Promise<void> {
  let lineNumber = 0;
  const callClasses = new Map<string, ItemClass>();
  await forEachLine(path, (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      state.summary.sources.rollout.malformedRecords += 1;
      return;
    }
    const entry = asRecord(parsed);
    if (!entry) {
      state.summary.sources.rollout.malformedRecords += 1;
      return;
    }
    const payload = asRecord(entry['payload']);
    const rawType = entry['type'];
    const rawSubtype = payload?.['type'] ?? entry['subtype'];
    const entryType = normalizeEntryType(rawType);
    const subtype = normalizeSubtype(rawSubtype);
    const compactionMarker = entryType === 'compaction' || subtype === 'compaction';
    const itemClass = resolveRolloutItemClass(rawSubtype, payload, callClasses);
    const itemObservation = isRolloutItemObservation(entryType, subtype, rawSubtype);
    const event: AnalysisTimelineEvent = {
      source: 'rollout',
      at: timestampNumber(entry['timestamp'] ?? payload?.['timestamp']),
      sequence: lineNumber,
      entryType,
      subtype,
      serializedLineBytes: Buffer.byteLength(line),
      contentBytes: rolloutContentByteLength(entry, payload, subtype),
      itemClass,
      itemObservation,
      compactionMarker,
    };
    if (subtype === 'token-count') event['tokenUsage'] = readRolloutUsage(payload);
    state.timeline.push(event);
    state.summary.sources.rollout.acceptedRecords += 1;
    state.summary.counts.rolloutEntryTypes[entryType] += 1;
    if (itemObservation) state.summary.coverage.itemSizeObservations = true;
    if (subtype === 'token-count') state.summary.coverage.rolloutTokenCountEvents = true;
    if (compactionMarker) state.summary.coverage.compactionMarkers = true;
    if (subtype === 'turn-start' || subtype === 'turn-complete') {
      state.summary.coverage.turnBoundaries = true;
    }
  });
}

function updateDiagnosticCoverage(kind: DiagnosticKind, summary: CodexContextAnalysisSummary): void {
  if (kind === 'transport-usage') summary.coverage.rawDiagnosticUsageNotifications = true;
  if (kind === 'item-completed') summary.coverage.itemSizeObservations = true;
  if (kind === 'transport-compaction' || kind === 'compaction-rpc' || kind === 'compaction-observed') {
    summary.coverage.compactionMarkers = true;
  }
  if (kind === 'turn-start' || kind === 'turn-complete') summary.coverage.turnBoundaries = true;
}

function readRolloutUsage(payload: Record<string, unknown> | null): {
  contextWindow: number | null;
  last: TokenSnapshot;
  cumulative: TokenSnapshot;
} {
  const info = asRecord(payload?.['info']);
  return {
    contextWindow: numericField(info ?? payload, 'modelContextWindow', 'model_context_window'),
    last: readTokenSnapshot(info?.['last_token_usage'] ?? info?.['lastTokenUsage'] ?? payload?.['last']),
    cumulative: readTokenSnapshot(
      info?.['total_token_usage'] ?? info?.['totalTokenUsage'] ?? payload?.['total'],
    ),
  };
}

function readTokenSnapshot(value: unknown): TokenSnapshot {
  const record = asRecord(value);
  return {
    totalTokens: numericField(record, 'totalTokens', 'total_tokens'),
    inputTokens: numericField(record, 'inputTokens', 'input_tokens'),
    cachedInputTokens: numericField(record, 'cachedInputTokens', 'cached_input_tokens'),
    outputTokens: numericField(record, 'outputTokens', 'output_tokens'),
    reasoningOutputTokens: numericField(record, 'reasoningOutputTokens', 'reasoning_output_tokens'),
  };
}

function withUsage(
  base: AnalysisTimelineEvent,
  data: Record<string, unknown>,
  numericKeys: readonly string[],
): AnalysisTimelineEvent {
  return {
    ...withNumbers(base, data, numericKeys),
    last: readTokenSnapshot(data['last']),
    cumulative: readTokenSnapshot(data['cumulative']),
  };
}

function withNumbers(
  base: AnalysisTimelineEvent,
  data: Record<string, unknown>,
  keys: readonly string[],
): AnalysisTimelineEvent {
  const output = { ...base };
  for (const key of keys) output[key] = finiteNumber(data[key]);
  return output;
}

function contentByteLength(value: unknown, depth = 0): number {
  if (depth > 50) return 0;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + contentByteLength(child, depth + 1), 0);
  const record = asRecord(value);
  if (!record) return 0;
  let total = 0;
  for (const [key, child] of Object.entries(record)) {
    total += CONTENT_KEYS.has(key) ? valueByteLength(child) : contentByteLength(child, depth + 1);
  }
  return total;
}

function rolloutContentByteLength(
  entry: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  subtype: RolloutSubtype,
): number {
  if (subtype !== 'tool-result') return contentByteLength(entry);
  const result = payload ?? entry;
  for (const key of [
    'aggregated_output', 'aggregatedOutput', 'formatted_output', 'formattedOutput',
    'output', 'result', 'content',
  ]) {
    if (result[key] !== undefined && result[key] !== null) return valueByteLength(result[key]);
  }
  return valueByteLength(result['stdout']) + valueByteLength(result['stderr']);
}

function valueByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function normalizeProviderKind(value: unknown): ProviderEventKind {
  const normalized = value === 'tool_use' ? 'tool-use' : value === 'tool_result' ? 'tool-result' : value;
  return isOneOf(normalized, PROVIDER_EVENT_KINDS) ? normalized : 'other';
}

function normalizeEntryType(value: unknown): RolloutEntryType {
  switch (value) {
    case 'session_meta': return 'session-metadata';
    case 'response_item': return 'response-item';
    case 'event_msg': return 'event-message';
    case 'turn_context': return 'turn-context';
    case 'compacted':
    case 'context_compacted': return 'compaction';
    default: return 'other';
  }
}

function normalizeSubtype(value: unknown): RolloutSubtype {
  switch (value) {
    case 'token_count': return 'token-count';
    case 'compacted':
    case 'context_compacted': return 'compaction';
    case 'message':
    case 'user_message':
    case 'agent_message': return 'message';
    case 'reasoning':
    case 'agent_reasoning': return 'reasoning';
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'exec_command_begin':
    case 'mcp_tool_call_begin': return 'tool-call';
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
    case 'exec_command_end':
    case 'mcp_tool_call_end': return 'tool-result';
    case 'web_search_call':
    case 'web_search_begin':
    case 'web_search_end': return 'web-search';
    case 'file_change':
    case 'apply_patch':
    case 'patch_apply_begin':
    case 'patch_apply_end': return 'file-change';
    case 'task_started':
    case 'turn_started': return 'turn-start';
    case 'task_complete':
    case 'turn_complete': return 'turn-complete';
    default: return 'other';
  }
}

function classifyRolloutItem(value: unknown, payload: Record<string, unknown> | null): ItemClass {
  switch (value) {
    case 'local_shell_call':
    case 'local_shell_call_output':
    case 'exec_command_begin':
    case 'exec_command_end': return 'command';
    case 'mcp_tool_call':
    case 'mcp_tool_call_output':
    case 'mcp_tool_call_begin':
    case 'mcp_tool_call_end': return 'mcp';
    case 'web_search_call':
    case 'web_search_begin':
    case 'web_search_end': return 'web';
    case 'file_change':
    case 'apply_patch':
    case 'patch_apply_begin':
    case 'patch_apply_end': return 'file-change';
    case 'collab_agent_tool_call': return 'collaboration';
    case 'agent_message': return 'agent-message';
    case 'reasoning':
    case 'agent_reasoning': return 'reasoning';
    case 'function_call':
    case 'custom_tool_call':
    case 'function_call_output':
    case 'custom_tool_call_output': return 'dynamic';
    case 'message':
      return asRecord(payload)?.['role'] === 'assistant' ? 'agent-message' : 'other';
    default: return 'other';
  }
}

function resolveRolloutItemClass(
  value: unknown,
  payload: Record<string, unknown> | null,
  callClasses: Map<string, ItemClass>,
): ItemClass {
  const directClass = classifyRolloutItem(value, payload);
  if (!isOneOf(value, [
    'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output',
  ] as const)) return directClass;

  const callId = stringField(payload, 'call_id', 'callId') ?? stringField(payload, 'id');
  const isResult = value === 'function_call_output' || value === 'custom_tool_call_output';
  if (isResult) {
    const correlated = callId ? callClasses.get(callId) : undefined;
    if (callId) callClasses.delete(callId);
    const namedClass = classifyGenericToolName(payload?.['name']);
    return namedClass ?? correlated ?? 'dynamic';
  }

  const itemClass = classifyGenericToolName(payload?.['name']) ?? 'dynamic';
  if (callId) setBoundedCallClass(callClasses, callId, itemClass);
  return itemClass;
}

function isRolloutItemObservation(
  entryType: RolloutEntryType,
  subtype: RolloutSubtype,
  rawSubtype: unknown,
): boolean {
  if (entryType === 'response-item') {
    return !isOneOf(rawSubtype, [
      'ghost_snapshot', 'world_state', 'world_state_update', 'token_count',
      'task_started', 'task_complete', 'turn_started', 'turn_complete', 'context_compacted',
    ] as const);
  }
  return entryType === 'event-message' && isOneOf(subtype, [
    'message', 'reasoning', 'tool-call', 'tool-result', 'web-search', 'file-change',
  ] as const);
}

function classifyGenericToolName(value: unknown): ItemClass | null {
  if (typeof value !== 'string') return null;
  const name = value.toLowerCase();
  if (name.startsWith('mcp__') || name.startsWith('mcp.') || name.includes('mcp_tool')) return 'mcp';
  if ([
    'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents',
  ].includes(name) || name.startsWith('collaboration.')) return 'collaboration';
  if (name.includes('apply_patch') || name.includes('patch_apply') || name.includes('file_change')) {
    return 'file-change';
  }
  if (name === 'exec_command' || name.endsWith('.exec_command') || name.endsWith('__exec_command')
    || name === 'shell' || name === 'bash' || name === 'terminal'
    || name.includes('run_command') || name.includes('execute_command')) return 'command';
  if (name === 'web.run' || name === 'web__run' || name.includes('web_search')) return 'web';
  return 'dynamic';
}

function setBoundedCallClass(
  correlations: Map<string, ItemClass>,
  callId: string,
  itemClass: ItemClass,
): void {
  if (!correlations.has(callId) && correlations.size >= MAX_CALL_CLASS_CORRELATIONS) {
    const oldest = correlations.keys().next().value as string | undefined;
    if (oldest) correlations.delete(oldest);
  }
  correlations.set(callId, itemClass);
}

function stringField(
  record: Record<string, unknown> | null,
  primary: string,
  secondary?: string,
): string | null {
  const value = record?.[primary] ?? (secondary ? record?.[secondary] : undefined);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeStatus(value: unknown): 'busy' | 'idle' | 'waiting' | 'working' | 'other' {
  switch (value) {
    case 'busy': return 'busy';
    case 'idle': return 'idle';
    case 'waiting':
    case 'waiting_for_input':
    case 'waiting-for-input': return 'waiting';
    case 'working':
    case 'thinking': return 'working';
    default: return 'other';
  }
}

function buildLimitations(summary: CodexContextAnalysisSummary): LimitationCode[] {
  const limitations: LimitationCode[] = [];
  if (!summary.sources.diagnosticLog.provided) limitations.push('diagnostic-log-not-supplied');
  if (!summary.sources.providerCaptures.provided) limitations.push('provider-captures-not-supplied');
  if (summary.sources.providerCaptures.provided && !summary.sources.providerCaptures.available) {
    limitations.push('provider-capture-table-unavailable');
  }
  if (!summary.sources.rollout.provided) limitations.push('rollout-not-supplied');
  if (!summary.coverage.rawDiagnosticUsageNotifications) limitations.push('raw-diagnostic-usage-unavailable');
  if (!summary.coverage.normalizedContextEvents) limitations.push('normalized-context-events-unavailable');
  if (!summary.coverage.rolloutTokenCountEvents) limitations.push('rollout-token-count-events-unavailable');
  if (!summary.coverage.itemSizeObservations) limitations.push('item-size-observations-unavailable');
  if (!summary.coverage.compactionMarkers) limitations.push('compaction-markers-unavailable');
  if (!summary.coverage.turnBoundaries) limitations.push('turn-boundaries-unavailable');
  return limitations;
}

const LIMITATION_TEXT: Record<LimitationCode, string> = {
  'diagnostic-log-not-supplied': 'No diagnostic log was supplied.',
  'provider-captures-not-supplied': 'No provider captures were supplied.',
  'provider-capture-table-unavailable': 'The supplied ledger capture table was unavailable.',
  'rollout-not-supplied': 'No rollout was supplied.',
  'raw-diagnostic-usage-unavailable': 'Raw diagnostic usage notifications were unavailable.',
  'normalized-context-events-unavailable': 'Normalized context events were unavailable.',
  'rollout-token-count-events-unavailable': 'Rollout token-count events were unavailable.',
  'item-size-observations-unavailable': 'Item-size observations were unavailable.',
  'compaction-markers-unavailable': 'Compaction markers were unavailable.',
  'turn-boundaries-unavailable': 'Turn boundaries were unavailable.',
};

function buildReport(
  summary: CodexContextAnalysisSummary,
  timeline: readonly AnalysisTimelineEvent[],
): string {
  const coverage = summary.coverage;
  const source = summary.sources;
  const rows = [
    ['Raw diagnostic usage notifications', coverage.rawDiagnosticUsageNotifications],
    ['Normalized context events', coverage.normalizedContextEvents],
    ['Rollout token-count events', coverage.rolloutTokenCountEvents],
    ['Item-size observations', coverage.itemSizeObservations],
    ['Compaction markers', coverage.compactionMarkers],
    ['Turn boundaries', coverage.turnBoundaries],
  ] as const;
  return [
    '# Codex Context Pressure Evidence Report',
    '',
    '## Source summary',
    '',
    '| Source | Supplied | Available | Accepted | Malformed |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Diagnostic log | ${yesNo(source.diagnosticLog.provided)} | ${yesNo(source.diagnosticLog.available)} | ${source.diagnosticLog.acceptedRecords} | ${source.diagnosticLog.malformedRecords} |`,
    `| Provider captures | ${yesNo(source.providerCaptures.provided)} | ${yesNo(source.providerCaptures.available)} | ${source.providerCaptures.acceptedRecords} | ${source.providerCaptures.malformedRecords} |`,
    `| Rollout | ${yesNo(source.rollout.provided)} | ${yesNo(source.rollout.available)} | ${source.rollout.acceptedRecords} | ${source.rollout.malformedRecords} |`,
    '',
    `Malformed diagnostic records: ${source.diagnosticLog.malformedRecords}`,
    '',
    'Usage evidence retains the first, final, and up to 98 evenly spaced middle observations.',
    '',
    '## Usage evidence',
    '',
    '| Evidence | At | Current used | Current delta | Cumulative | Cumulative delta | Window | Occupancy % |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...usageEvidenceRows(timeline),
    '',
    '## Item-size evidence',
    '',
    '| Item class | Count | Content bytes | Serialized bytes |',
    '| --- | ---: | ---: | ---: |',
    ...itemEvidenceRows(timeline),
    '',
    '## Compaction and turn observations',
    '',
    '| Observation | Count |',
    '| --- | ---: |',
    ...observationRows(timeline),
    '',
    '## Coverage',
    '',
    '| Evidence | Present |',
    '| --- | ---: |',
    ...rows.map(([label, present]) => `| ${label} | ${yesNo(present)} |`),
    '',
    '## Limitations',
    '',
    ...(summary.limitations.length > 0
      ? summary.limitations.map((code) => `- ${LIMITATION_TEXT[code]}`)
      : ['- No source-coverage limitation was detected.']),
    '',
  ].join('\n');
}

interface UsageEvidenceObservation {
  label: 'diagnostic transport usage' | 'diagnostic token usage' | 'normalized context' | 'rollout token count';
  at: number | null;
  current: number | null;
  currentDelta: number | null;
  cumulative: number | null;
  cumulativeDelta: number | null;
  window: number | null;
  occupancy: number | null;
}

function usageEvidenceRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const observations = collectUsageEvidence(timeline);
  if (observations.length === 0) return ['| none | — | — | — | — | — | — | — |'];
  const selected = selectBoundedUsageObservations(observations);
  const rows = selected.map(renderUsageObservation);
  const omitted = observations.length - selected.length;
  if (omitted > 0) rows.splice(1, 0, `| omitted observations | ${omitted} | — | — | — | — | — | — |`);
  return rows;
}

function collectUsageEvidence(
  timeline: readonly AnalysisTimelineEvent[],
): UsageEvidenceObservation[] {
  const observations: UsageEvidenceObservation[] = [];
  const previous = new Map<UsageEvidenceObservation['label'], {
    current: number | null;
    cumulative: number | null;
  }>();
  for (const event of timeline) {
    let label: UsageEvidenceObservation['label'] | null = null;
    let current: number | null = null;
    let cumulative: number | null = null;
    let currentDelta: number | null = null;
    let cumulativeDelta: number | null = null;
    let window: number | null = null;
    let occupancy: number | null = null;
    if (event.source === 'diagnostic' && event.kind === 'transport-usage') {
      label = 'diagnostic transport usage';
      current = snapshotTotal(event['last']);
      cumulative = snapshotTotal(event['cumulative']);
      window = finiteNumber(event['contextWindow']);
    } else if (event.source === 'diagnostic' && event.kind === 'token-usage') {
      label = 'diagnostic token usage';
      current = snapshotTotal(event['last']);
      cumulative = snapshotTotal(event['cumulative']);
      currentDelta = finiteNumber(event['lastTotalDelta']);
      cumulativeDelta = finiteNumber(event['cumulativeTotalDelta']);
      window = finiteNumber(event['contextWindow']);
      occupancy = finiteNumber(event['occupancyPercentage']);
    } else if (event.source === 'provider-capture' && event.kind === 'context') {
      label = 'normalized context';
      current = finiteNumber(event['usedTokens']);
      window = finiteNumber(event['contextWindow']);
      occupancy = finiteNumber(event['occupancyPercentage']);
    } else if (event.source === 'rollout' && event.subtype === 'token-count') {
      label = 'rollout token count';
      const usage = asRecord(event['tokenUsage']);
      current = snapshotTotal(usage?.['last']);
      cumulative = snapshotTotal(usage?.['cumulative']);
      window = finiteNumber(usage?.['contextWindow']);
    }
    if (!label) continue;
    const prior = previous.get(label);
    currentDelta ??= difference(current, prior?.current ?? null);
    cumulativeDelta ??= difference(cumulative, prior?.cumulative ?? null);
    occupancy ??= current !== null && window !== null && window > 0 ? (current / window) * 100 : null;
    observations.push({
      label, at: event.at, current, currentDelta, cumulative, cumulativeDelta, window, occupancy,
    });
    previous.set(label, { current, cumulative });
  }
  return observations;
}

function selectBoundedUsageObservations(
  observations: readonly UsageEvidenceObservation[],
): UsageEvidenceObservation[] {
  const limit = 100;
  if (observations.length <= limit) return [...observations];
  const indexes = new Set<number>([0, observations.length - 1]);
  for (let slot = 1; slot < limit - 1; slot += 1) {
    indexes.add(Math.round((slot * (observations.length - 1)) / (limit - 1)));
  }
  for (let index = 1; indexes.size < limit && index < observations.length - 1; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right).map((index) => observations[index]!);
}

function renderUsageObservation(observation: UsageEvidenceObservation): string {
  return `| ${observation.label} | ${reportNumber(observation.at)} | ${reportNumber(observation.current)} | ${reportNumber(observation.currentDelta)} | ${reportNumber(observation.cumulative)} | ${reportNumber(observation.cumulativeDelta)} | ${reportNumber(observation.window)} | ${reportNumber(observation.occupancy)} |`;
}

function difference(current: number | null, previous: number | null): number | null {
  return current !== null && previous !== null ? current - previous : null;
}

function itemEvidenceRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const totals = new Map<ItemClass, { count: number; content: number; serialized: number }>();
  for (const event of timeline) {
    if (event.kind !== 'item-completed' && event['itemObservation'] !== true) continue;
    const itemClass = event['itemClass'];
    if (!ITEM_CLASSES.has(itemClass as ItemClass)) continue;
    const current = totals.get(itemClass as ItemClass) ?? { count: 0, content: 0, serialized: 0 };
    current.count += 1;
    current.content += finiteNumber(event['observedPayloadBytes'] ?? event['contentBytes']) ?? 0;
    current.serialized += finiteNumber(event['serializedItemBytes'] ?? event['serializedLineBytes']) ?? 0;
    totals.set(itemClass as ItemClass, current);
  }
  const rows: string[] = [];
  for (const itemClass of ITEM_CLASSES) {
    const total = totals.get(itemClass);
    if (total) rows.push(`| ${itemClass} | ${total.count} | ${total.content} | ${total.serialized} |`);
  }
  return rows.length > 0 ? rows : ['| none | 0 | 0 | 0 |'];
}

function observationRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const counts = new Map<string, number>();
  const increment = (label: string): void => {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  };
  for (const event of timeline) {
    if (event.kind === 'compaction-observed') increment('compaction observed');
    if (event.kind === 'transport-compaction') increment('transport compaction');
    if (event.kind === 'compaction-rpc') {
      const stage = event['stage'];
      if (isOneOf(stage, ['requested', 'accepted', 'failed'] as const)) {
        increment(`compaction RPC ${stage}`);
      }
    }
    if (event.source === 'rollout' && event['compactionMarker'] === true) increment('rollout compaction');
    if (event.kind === 'turn-start' || event.subtype === 'turn-start') increment('turn start');
    if (event.kind === 'turn-complete' || event.subtype === 'turn-complete') increment('turn complete');
  }
  const order = [
    'compaction observed', 'transport compaction', 'compaction RPC requested',
    'compaction RPC accepted', 'compaction RPC failed', 'rollout compaction',
    'turn start', 'turn complete',
  ];
  const rows = order.filter((label) => counts.has(label))
    .map((label) => `| ${label} | ${counts.get(label)} |`);
  return rows.length > 0 ? rows : ['| none | 0 |'];
}

function snapshotTotal(value: unknown): number | null {
  return finiteNumber(asRecord(value)?.['totalTokens']);
}

function reportNumber(value: unknown): string {
  const numeric = finiteNumber(value);
  return numeric === null ? '—' : String(Math.round(numeric * 100) / 100);
}

async function forEachLine(path: string, visitor: (line: string) => void): Promise<void> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) visitor(line);
}

function compareTimelineEvents(left: AnalysisTimelineEvent, right: AnalysisTimelineEvent): number {
  const leftAt = left.at ?? Number.MAX_SAFE_INTEGER;
  const rightAt = right.at ?? Number.MAX_SAFE_INTEGER;
  if (leftAt !== rightAt) return leftAt - rightAt;
  const sourceOrder = { diagnostic: 0, 'provider-capture': 1, rollout: 2 } as const;
  if (left.source !== right.source) return sourceOrder[left.source] - sourceOrder[right.source];
  return left.sequence - right.sequence;
}

function timestampNumber(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validNumbers(
  record: Record<string, unknown>,
  required: readonly string[],
  nullable: readonly string[] = [],
): boolean {
  return required.every((key) => finiteNumber(record[key]) !== null)
    && nullable.every((key) => record[key] === null || finiteNumber(record[key]) !== null);
}

function validUsage(record: Record<string, unknown>): boolean {
  return validSnapshot(record['last']) && validSnapshot(record['cumulative']);
}

function validSnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  return snapshot !== null && validNumbers(snapshot, [], [
    'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
  ]);
}

function numericField(
  record: Record<string, unknown> | null,
  camelCase: string,
  snakeCase: string,
): number | null {
  return finiteNumber(record?.[camelCase] ?? record?.[snakeCase]);
}

function copyNumeric(
  output: AnalysisTimelineEvent,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
): void {
  output[outputKey] = finiteNumber(input[inputKey]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function zeroCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function toJsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

function parseArgs(argv: string[]): CodexContextAnalysisOptions {
  const valueFor = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const outDir = valueFor('--out');
  if (!outDir) {
    throw new Error('Usage: tsx scripts/analyze-codex-context-pressure.ts [--log <app.log>] [--db <ledger.db> --instance <id>] [--rollout <rollout.jsonl>] --out <directory>');
  }
  return {
    logPath: valueFor('--log'),
    dbPath: valueFor('--db'),
    instanceId: valueFor('--instance'),
    rolloutPath: valueFor('--rollout'),
    outDir,
  };
}

async function main(): Promise<void> {
  await analyzeCodexContextPressure(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Context-pressure analysis failed');
    process.exitCode = 1;
  });
}
