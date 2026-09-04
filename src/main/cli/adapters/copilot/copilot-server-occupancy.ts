import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import type { ContextUsageObservation } from '../base-cli-adapter.types';

export interface CopilotServerOccupancySample {
  used: number;
  total: number;
  conversationTokens?: number;
  systemTokens?: number;
  toolDefinitionsTokens?: number;
}

const EXEC_CONTEXT_CAPABILITIES: ProviderContextCapabilities = {
  toolResultControl: 'post-retention',
  toolResultVisibility: 'full',
  transcriptControl: 'none',
  occupancyReporting: 'aggregate-only',
  cumulativeReporting: 'available',
  interruptProof: 'none',
  compactionProof: 'none',
  sameThreadContinuation: false,
};

const SERVER_CONTEXT_CAPABILITIES: ProviderContextCapabilities = {
  ...EXEC_CONTEXT_CAPABILITIES,
  occupancyReporting: 'current',
};

export function copilotContextCapabilities(serverModeLive: boolean): ProviderContextCapabilities {
  return serverModeLive ? SERVER_CONTEXT_CAPABILITIES : EXEC_CONTEXT_CAPABILITIES;
}

export function copilotLastContextUsage(
  serverModeLive: boolean,
  sample: CopilotServerOccupancySample | null,
): ContextUsageObservation {
  if (!serverModeLive) return { status: 'unknown', reason: 'aggregate-only' };
  if (!sample) return { status: 'unknown', reason: 'not-reported' };
  if (!Number.isFinite(sample.used) || sample.used < 0
    || !Number.isFinite(sample.total) || sample.total <= 0) {
    return { status: 'unknown', reason: 'invalid-sample' };
  }
  if (sample.used === 0) return { status: 'unknown', reason: 'not-reported' };
  return {
    status: 'known',
    used: sample.used,
    total: sample.total,
    source: 'provider-session',
    windowTrusted: true,
    ...(typeof sample.conversationTokens === 'number' ? { conversationTokens: sample.conversationTokens } : {}),
    ...(typeof sample.systemTokens === 'number' ? { systemTokens: sample.systemTokens } : {}),
    ...(typeof sample.toolDefinitionsTokens === 'number'
      ? { toolDefinitionsTokens: sample.toolDefinitionsTokens }
      : {}),
  };
}
