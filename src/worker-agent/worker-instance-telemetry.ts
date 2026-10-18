import type { EventEmitter } from 'events';
import type { AcpSystemPromptDelivery } from '../main/cli/adapters/acp-system-prompt-delivery';
import type { ClaudeSubagentUsage } from '../main/cli/adapters/claude-subagent-usage';
import type { InstanceTelemetry } from '../main/remote-node/instance-telemetry-rpc';

/** Paired listeners share the instance manager's existing runtime teardown. */
export function observeWorkerInstanceTelemetry(adapter: EventEmitter, emit: (telemetry: InstanceTelemetry) => void): () => void {
  const onDelivery = ({ originalChars, deliveredChars, truncated, omittedHeadings }: Omit<AcpSystemPromptDelivery, 'block'>): void => {
    emit({ event: 'system_prompt_delivered', payload: { originalChars, deliveredChars, truncated, omittedHeadings } });
  };
  const onSubagent = ({ toolUseId, finalContextTokens, toolUses, durationMs, final }: ClaudeSubagentUsage): void => {
    emit({ event: 'subagent_usage', payload: { toolUseId, finalContextTokens, toolUses, durationMs, final } });
  };
  adapter.on('system_prompt_delivered', onDelivery);
  adapter.on('subagent_usage', onSubagent);
  return () => {
    adapter.off('system_prompt_delivered', onDelivery);
    adapter.off('subagent_usage', onSubagent);
  };
}
