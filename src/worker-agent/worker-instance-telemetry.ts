import type { EventEmitter } from 'events';
import type { AcpSystemPromptDelivery } from '../main/cli/adapters/acp-system-prompt-delivery';
import type { ClaudeSubagentUsage } from '../main/cli/adapters/claude-subagent-usage';
import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from '../main/core/system/session-policy-log';
import type { InstanceTelemetry } from '../main/remote-node/instance-telemetry-rpc';
import type { NativeHelperSummary } from '../shared/types/instance.types';

/** Paired listeners share the instance manager's existing runtime teardown. */
export function observeWorkerInstanceTelemetry(adapter: EventEmitter, emit: (telemetry: InstanceTelemetry) => void): () => void {
  const onDelivery = ({ originalChars, deliveredChars, truncated, omittedHeadings }: Omit<AcpSystemPromptDelivery, 'block'>): void => {
    emit({ event: 'system_prompt_delivered', payload: { originalChars, deliveredChars, truncated, omittedHeadings } });
  };
  const onSubagent = ({ toolUseId, finalContextTokens, toolUses, durationMs, final }: ClaudeSubagentUsage): void => {
    emit({ event: 'subagent_usage', payload: { toolUseId, finalContextTokens, toolUses, durationMs, final } });
  };
  const onTurnShare = ({ threadId, turnId, revision, rootTokens, helperTokens, totalTokens, helperShare, wrapUpDelivered, stopRequested }: SessionTurnShareRecord): void => {
    emit({ event: 'session_turn_share', payload: { threadId, turnId, revision, rootTokens, helperTokens, totalTokens, helperShare, wrapUpDelivered, stopRequested } });
  };
  const onThreadCredits = ({ threadId, estimatedUsageCreditsMicros, estimatedUsageUsdMicros, totalTokens, groups }: SessionThreadCreditsRecord): void => {
    emit({ event: 'session_thread_credits', payload: { threadId, estimatedUsageCreditsMicros, estimatedUsageUsdMicros, totalTokens, groups } });
  };
  const onNativeHelpers = ({ running }: NativeHelperSummary): void => {
    emit({ event: 'native_helpers', payload: { running } });
  };
  adapter.on('system_prompt_delivered', onDelivery);
  adapter.on('subagent_usage', onSubagent);
  adapter.on('session_turn_share', onTurnShare);
  adapter.on('session_thread_credits', onThreadCredits);
  adapter.on('native_helpers', onNativeHelpers);
  return () => {
    adapter.off('system_prompt_delivered', onDelivery);
    adapter.off('subagent_usage', onSubagent);
    adapter.off('session_turn_share', onTurnShare);
    adapter.off('session_thread_credits', onThreadCredits);
    adapter.off('native_helpers', onNativeHelpers);
  };
}
