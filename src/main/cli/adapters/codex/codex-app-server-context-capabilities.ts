import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import type { CodexOutputLimitState } from './codex-app-server-spawn-policy';

const SHARED = {
  toolResultVisibility: 'full',
  cumulativeReporting: 'available',
} as const;

export function buildCodexAppServerContextCapabilities(
  outputLimitState: CodexOutputLimitState | undefined,
): ProviderContextCapabilities {
  return {
    toolResultControl: outputLimitState === 'applied' ? 'pre-retention' : 'post-retention',
    ...SHARED,
    transcriptControl: 'native-compaction',
    occupancyReporting: 'current',
    interruptProof: 'observed',
    compactionProof: 'observed',
    sameThreadContinuation: true,
  };
}

export function buildCodexExecContextCapabilities(): ProviderContextCapabilities {
  return {
    toolResultControl: 'post-retention',
    ...SHARED,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  };
}
