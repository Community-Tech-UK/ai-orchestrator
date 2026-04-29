import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';

export type InterruptBoundaryPhase =
  | 'requested'
  | 'cancelling'
  | 'escalated'
  | 'respawning'
  | 'completed';

export type InterruptBoundaryOutcome =
  | 'cancelled'
  | 'cancelled-for-edit'
  | 'respawn-success'
  | 'respawn-fallback'
  | 'unresolved';

export interface InterruptBoundaryMarker {
  phase: InterruptBoundaryPhase;
  requestId: string;
  outcome: InterruptBoundaryOutcome;
  at?: number;
  reason?: string;
  fallbackMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
}

export interface InterruptBoundaryEmitterDeps {
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  emitOutput: (instanceId: string, message: OutputMessage) => void;
}

export function buildInterruptBoundaryMessage(marker: InterruptBoundaryMarker): OutputMessage {
  const at = marker.at ?? Date.now();
  return {
    id: generateId(),
    timestamp: at,
    type: 'system',
    content: `Interrupt ${marker.phase}: ${marker.outcome}`,
    metadata: {
      kind: 'interrupt-boundary',
      phase: marker.phase,
      requestId: marker.requestId,
      outcome: marker.outcome,
      at,
      reason: marker.reason,
      fallbackMode: marker.fallbackMode,
    },
  };
}

export function emitInterruptBoundaryDisplayMarker(
  instance: Instance,
  marker: InterruptBoundaryMarker,
  deps: InterruptBoundaryEmitterDeps,
): void {
  const message = buildInterruptBoundaryMessage(marker);
  deps.addToOutputBuffer(instance, message);
  deps.emitOutput(instance.id, message);
}
