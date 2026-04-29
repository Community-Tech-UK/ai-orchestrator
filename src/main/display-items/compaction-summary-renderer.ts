import type { OutputMessage } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';
import type { InstanceManager } from '../instance/instance-manager';
import type { SessionContinuityManager } from '../session/session-continuity';

export interface CompactionDisplayPayload {
  instanceId: string;
  reason: string;
  beforeCount: number;
  afterCount: number;
  tokensReclaimed?: number;
  fallbackMode?: 'in-place' | 'snapshot-restore' | 'native-resume' | 'replay-fallback';
}

export function buildCompactionSummaryMessage(payload: CompactionDisplayPayload): OutputMessage {
  const at = Date.now();
  return {
    id: generateId(),
    timestamp: at,
    type: 'system',
    content: `Context compacted: ${payload.beforeCount} -> ${payload.afterCount} messages`,
    metadata: {
      kind: 'compaction-summary',
      reason: payload.reason,
      beforeCount: payload.beforeCount,
      afterCount: payload.afterCount,
      tokensReclaimed: payload.tokensReclaimed,
      fallbackMode: payload.fallbackMode ?? 'in-place',
      at,
    },
  };
}

export function registerCompactionSummaryRenderer(
  continuity: Pick<SessionContinuityManager, 'on' | 'off'>,
  instanceManager: Pick<InstanceManager, 'emitOutputMessage'>,
): () => void {
  const listener = (payload: CompactionDisplayPayload): void => {
    instanceManager.emitOutputMessage(payload.instanceId, buildCompactionSummaryMessage(payload));
  };

  continuity.on('session:compaction-display', listener);
  return () => {
    continuity.off('session:compaction-display', listener);
  };
}
