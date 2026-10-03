import type { ProviderRuntimeEvent, ProviderToolResultEvent, ProviderToolUseEvent } from '@contracts/types/provider-runtime-events';

/** Normalize real non-ACP output tool records without double-counting ACP echoes. */
export function readTurnToolObservation(event: ProviderRuntimeEvent): ProviderToolUseEvent | ProviderToolResultEvent | undefined {
  if (event.kind === 'tool_use' || event.kind === 'tool_result') return event;
  if (event.kind !== 'output' || event.metadata?.['transport'] === 'acp') return undefined;
  if (!['tool_use', 'tool_result'].includes(event.messageType ?? '')) return undefined;
  const meta = event.metadata ?? {};
  const toolUseId = ['id', 'toolCallId', 'tool_use_id', 'toolUseId'].map((key) => meta[key]).find((value): value is string => typeof value === 'string' && Boolean(value));
  const name = meta['name'] ?? meta['toolName'];
  const toolName = typeof name === 'string' ? name : 'unknown';
  const value = meta['input'] ?? meta['arguments'];
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  return event.messageType === 'tool_use'
    ? { kind: 'tool_use', toolUseId, toolName, input }
    : { kind: 'tool_result', toolUseId, toolName, output: event.content, success: meta['is_error'] !== true && meta['isError'] !== true };
}
