import { Buffer } from 'node:buffer';
import {
  asRecord,
  forEachLine,
  isOneOf,
  numericField,
  readTokenSnapshot,
  stringField,
  timestampNumber,
  valueByteLength,
} from './shared';
import {
  type AnalysisState,
  type AnalysisTimelineEvent,
  type ItemClass,
  type RolloutEntryType,
  type RolloutSubtype,
  type TokenSnapshot,
} from './types';

const CONTENT_KEYS = new Set<string>([
  'content', 'text', 'message', 'prompt', 'instructions', 'command', 'args',
  'arguments', 'input', 'output', 'result', 'query', 'url', 'path', 'cwd',
]);

const MAX_CALL_CLASS_CORRELATIONS = 1_000;

export async function parseRollout(path: string, state: AnalysisState): Promise<void> {
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
