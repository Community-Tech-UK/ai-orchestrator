import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import { toJsonSafeProviderEventPayload } from '../providers/provider-event-raw-payload';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventRaw,
} from '@contracts/types/provider-runtime-events';

interface BindRawAdapterProviderEventsInput {
  adapter: CliAdapter;
  isStale: (eventName: string) => boolean;
  emit: (
    event: ProviderRuntimeEvent,
    options: { raw: ProviderRuntimeEventRaw; provider?: ProviderName },
  ) => void;
}

/** Bind canonical capture for adapter events not otherwise handled by the UI. */
export function bindRawAdapterProviderEvents(input: BindRawAdapterProviderEventsInput): void {
  input.adapter.on('spawned', (pid: number) => {
    if (input.isStale('spawned')) return;
    input.emit(
      { kind: 'spawned', pid },
      { raw: { source: 'adapter-event:spawned', payload: toJsonSafeProviderEventPayload(pid) } },
    );
  });

  input.adapter.on('tool_use', (toolCall: CliToolCall) => {
    if (input.isStale('tool_use')) return;
    input.emit(
      {
        kind: 'tool_use',
        toolName: toolCall.name,
        toolUseId: toolCall.id,
        input: toolCall.arguments,
      },
      { raw: { source: 'adapter-event:tool_use', payload: toJsonSafeProviderEventPayload(toolCall) } },
    );
  });

  input.adapter.on('tool_result', (toolCall: CliToolCall) => {
    if (input.isStale('tool_result')) return;
    input.emit(
      {
        kind: 'tool_result',
        toolName: toolCall.name,
        toolUseId: toolCall.id,
        success: true,
        ...(toolCall.result !== undefined ? { output: toolCall.result } : {}),
      },
      { raw: { source: 'adapter-event:tool_result', payload: toJsonSafeProviderEventPayload(toolCall) } },
    );
  });
}
