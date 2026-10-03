import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { CliAsyncWorkEvent } from '../cli/adapters/claude-cli-async-work';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
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
  captureToolResult?: (toolCall: CliToolCall) => void;
  observeAsyncWork?: (event: CliAsyncWorkEvent) => void;
}

/** Bind canonical capture for adapter events not otherwise handled by the UI. */
export function bindRawAdapterProviderEvents(input: BindRawAdapterProviderEventsInput): void {
  // Terminal provider turn failure is distinct from a broken adapter. The
  // send rejection still owns overflow/limit/auth recovery; this records the
  // canonical ending synchronously without teardown, hooks or a second notice.
  input.adapter.on('turn_error', (error: Error) => {
    if (input.isStale('turn_error')) return;
    const mapped = mapAdapterRuntimeEvent('turn_error', [error]);
    const evidence = error as Error & { errorCode?: string; statusCode?: number };
    if (mapped) input.emit(mapped.event, {
      raw: { source: 'adapter-event:turn_error', payload: {
        message: error.message, willRetry: false,
        ...(evidence.errorCode ? { errorCode: evidence.errorCode } : {}),
        ...(evidence.statusCode !== undefined ? { statusCode: evidence.statusCode } : {}),
        ...(mapped.event.kind === 'error' && mapped.event.quota ? { quota: mapped.event.quota } : {}),
      } },
    });
  });
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
    input.captureToolResult?.(toolCall);
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

  input.adapter.on('async_work', (event: CliAsyncWorkEvent) => {
    if (input.isStale('async_work')) return;
    input.observeAsyncWork?.(event);
  });
}
