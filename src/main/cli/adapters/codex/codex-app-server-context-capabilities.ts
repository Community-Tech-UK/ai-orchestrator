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
    // Codex compacts inside the running turn at 90% of the window. Harness's
    // own 70/75/80% actions pre-empted it with turn interrupts and replaced
    // turns. t3code, another Codex app-server client, leaves compaction to Codex.
    providerAutoCompaction: 'inline',
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
