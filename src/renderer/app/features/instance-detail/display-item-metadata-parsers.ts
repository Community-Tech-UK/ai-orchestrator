import type { OutputMessage } from '../../core/state/instance/instance.types';
import type {
  CompactionFallbackMode,
  CompactionSummaryDisplay,
  InterruptBoundaryDisplay,
  InterruptDisplayOutcome,
  InterruptDisplayPhase,
} from './display-item.types';

export function parseInterruptBoundary(message: OutputMessage): InterruptBoundaryDisplay | null {
  if (message.type !== 'system' || message.metadata?.['kind'] !== 'interrupt-boundary') {
    return null;
  }

  const phase = message.metadata['phase'];
  const requestId = message.metadata['requestId'];
  const outcome = message.metadata['outcome'];
  const at = message.metadata['at'];
  if (
    !isInterruptDisplayPhase(phase) ||
    typeof requestId !== 'string' ||
    !isInterruptDisplayOutcome(outcome)
  ) {
    return null;
  }

  const fallbackMode = message.metadata['fallbackMode'];
  return {
    phase,
    requestId,
    outcome,
    at: typeof at === 'number' ? at : message.timestamp,
    reason: typeof message.metadata['reason'] === 'string' ? message.metadata['reason'] : undefined,
    fallbackMode: isInterruptFallbackMode(fallbackMode) ? fallbackMode : undefined,
  };
}

export function parseCompactionSummary(message: OutputMessage): CompactionSummaryDisplay | null {
  if (message.type !== 'system' || message.metadata?.['kind'] !== 'compaction-summary') {
    return null;
  }

  const reason = message.metadata['reason'];
  const beforeCount = message.metadata['beforeCount'];
  const afterCount = message.metadata['afterCount'];
  const at = message.metadata['at'];
  if (
    typeof reason !== 'string' ||
    typeof beforeCount !== 'number' ||
    typeof afterCount !== 'number'
  ) {
    return null;
  }

  const fallbackMode = message.metadata['fallbackMode'];
  const tokensReclaimed = message.metadata['tokensReclaimed'];
  const markerId = message.metadata['compactionMarkerId'];
  return {
    reason,
    beforeCount,
    afterCount,
    tokensReclaimed: typeof tokensReclaimed === 'number' ? tokensReclaimed : undefined,
    fallbackMode: isCompactionFallbackMode(fallbackMode) ? fallbackMode : undefined,
    markerId: typeof markerId === 'string' ? markerId : undefined,
    at: typeof at === 'number' ? at : message.timestamp,
  };
}

function isInterruptDisplayPhase(value: unknown): value is InterruptDisplayPhase {
  return value === 'requested' ||
    value === 'cancelling' ||
    value === 'escalated' ||
    value === 'respawning' ||
    value === 'completed';
}

function isInterruptDisplayOutcome(value: unknown): value is InterruptDisplayOutcome {
  return value === 'cancelled' ||
    value === 'cancelled-for-edit' ||
    value === 'respawn-success' ||
    value === 'respawn-fallback' ||
    value === 'unresolved';
}

function isInterruptFallbackMode(value: unknown): value is InterruptBoundaryDisplay['fallbackMode'] {
  return value === 'native-resume' ||
    value === 'resume-unconfirmed' ||
    value === 'replay-fallback';
}

function isCompactionFallbackMode(value: unknown): value is CompactionFallbackMode {
  return value === 'in-place' ||
    value === 'snapshot-restore' ||
    value === 'native-resume' ||
    value === 'replay-fallback';
}
