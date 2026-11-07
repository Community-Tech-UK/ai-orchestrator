import { publishSubagentUsage } from './subagent-usage-publisher';
import type { ClaudeSelfWakeupEvent } from '../cli/adapters/claude-cli-self-wakeup';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { CliAsyncWorkEvent } from '../cli/adapters/claude-cli-async-work';
import { subagentAttributionDetails, type ClaudeSubagentUsage } from '../cli/adapters/claude-subagent-usage';
import { recordClaudeCacheLifetime, type ClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';
import type { Instance } from '../../shared/types/instance.types';
import { recordCostAttribution } from '../core/system/cost-attribution';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
import { toJsonSafeProviderEventPayload } from '../providers/provider-event-raw-payload';
import { nativeOpenCodeCommands } from '../commands/provider-native-commands';
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
  observeSelfWakeup?: (event: ClaudeSelfWakeupEvent) => void;
  observeAsyncWork?: (event: CliAsyncWorkEvent) => void;
  observeAvailableCommands?: () => void;
  getInstance?: () => Instance | undefined;
}

/** Bind canonical capture for adapter events not otherwise handled by the UI. */
export function bindRawAdapterProviderEvents(input: BindRawAdapterProviderEventsInput): void {
  // Compare the effective menu projection, not the provider's unbounded payload.
  // Undefined deliberately makes the first empty catalog observable too.
  let lastCatalog: string | undefined;
  input.adapter.on('available_commands', () => {
    if (input.isStale('available_commands')) return;
    const catalog = JSON.stringify(nativeOpenCodeCommands('opencode', input.adapter)
      .map(({ id, name, description }) => ({ id, name, description })));
    if (catalog === lastCatalog) return;
    lastCatalog = catalog;
    input.observeAvailableCommands?.();
  });

  // A remote worker measured this lifetime; keep it where local adapters keep theirs.
  input.adapter.on('cache_lifetime', (value: ClaudeCacheLifetime) => {
    if (!input.isStale('cache_lifetime')) recordClaudeCacheLifetime(input.adapter, value);
  });

  const lastSubagentPush = new Map<string, number>();
  const recordedSubagents = new Set<string>();
  input.adapter.on('subagent_usage', (sample: ClaudeSubagentUsage) => {
    if (input.isStale('subagent_usage') || recordedSubagents.has(sample.toolUseId)) return;
    const instance = input.getInstance?.();
    if (!instance) return;
    const now = Date.now();
    if (sample.final || !lastSubagentPush.has(sample.toolUseId) || now - lastSubagentPush.get(sample.toolUseId)! >= 2000) {
      lastSubagentPush.set(sample.toolUseId, now);
      publishSubagentUsage({ instanceId: instance.id, toolUseId: sample.toolUseId, finalContextTokens: sample.finalContextTokens,
        toolUses: sample.toolUses, durationMs: sample.durationMs, final: sample.final });
    }
    if (!sample.final) return;
    lastSubagentPush.delete(sample.toolUseId);
    recordedSubagents.add(sample.toolUseId);
    recordCostAttribution({source:'instance-turn',purpose:'subagent',taskType:'claude-subagent-final',
      provider:'claude',instanceId:instance.id,sessionId:instance.sessionId,costSource:'unknown',costKnown:false,
      subagentUsage:true,finalContextTokens:sample.finalContextTokens,toolUses:sample.toolUses,
      durationMs:sample.durationMs,toolUseId:sample.toolUseId,...subagentAttributionDetails(sample)});
  });
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
    const mapped = mapAdapterRuntimeEvent('tool_result', [toolCall]);
    if (mapped) input.emit(mapped.event,
      { raw: { source: 'adapter-event:tool_result', payload: toJsonSafeProviderEventPayload(toolCall) } });
  });

  input.adapter.on('self_wakeup', (event: ClaudeSelfWakeupEvent) => {
    if (input.isStale('self_wakeup')) return;
    input.observeSelfWakeup?.(event);
  });

  input.adapter.on('async_work', (event: CliAsyncWorkEvent) => {
    if (input.isStale('async_work')) return;
    input.observeAsyncWork?.(event);
  });
}
