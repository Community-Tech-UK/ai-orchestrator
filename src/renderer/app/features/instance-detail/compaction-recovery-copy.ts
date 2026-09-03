/**
 * Compaction-recovery button labels for the output stream.
 *
 * Extracted from `output-stream.component.ts` so the component stays inside
 * its LOC ceiling. Behaviour matches the previous methods.
 */

export type CompactionRecoveryState = 'recovering' | 'queued' | 'failed';

export function compactionRecoveryLabel(state: CompactionRecoveryState | undefined): string {
  switch (state) {
    case 'recovering':
      return 'Recovering';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Retry recover';
    default:
      return 'Recover context';
  }
}

export function isCompactionRecoveryDisabled(state: CompactionRecoveryState | undefined): boolean {
  return state === 'recovering' || state === 'queued';
}
