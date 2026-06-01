import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { ThinkingContent } from '../../../../shared/types/instance.types';
import type { CopilotPlanUpdate } from './copilot-plan-update';

export interface DisplayItem {
  id: string;
  type:
    | 'message'
    | 'plan-update'
    | 'tool-group'
    | 'thought-group'
    | 'work-cycle'
    | 'system-event-group'
    | 'interrupt-boundary'
    | 'compaction-summary';
  message?: OutputMessage;
  renderedMessage?: unknown;
  planUpdate?: CopilotPlanUpdate;
  toolMessages?: OutputMessage[];
  thinking?: ThinkingContent[];
  thoughts?: string[];
  response?: OutputMessage;
  renderedResponse?: unknown;
  timestamp?: number;
  repeatCount?: number;
  showHeader?: boolean;
  bufferIndex?: number;
  children?: DisplayItem[];
  systemEvents?: OutputMessage[];
  groupAction?: string;
  groupLabel?: string;
  groupPreview?: string;
  interruptBoundary?: InterruptBoundaryDisplay;
  compactionSummary?: CompactionSummaryDisplay;
}

export type InterruptDisplayPhase =
  | 'requested'
  | 'cancelling'
  | 'escalated'
  | 'respawning'
  | 'completed';

export type InterruptDisplayOutcome =
  | 'cancelled'
  | 'cancelled-for-edit'
  | 'respawn-success'
  | 'respawn-fallback'
  | 'unresolved';

export interface InterruptBoundaryDisplay {
  phase: InterruptDisplayPhase;
  requestId: string;
  outcome: InterruptDisplayOutcome;
  at: number;
  reason?: string;
  fallbackMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
}

export type CompactionFallbackMode =
  | 'in-place'
  | 'snapshot-restore'
  | 'native-resume'
  | 'replay-fallback';

export interface CompactionSummaryDisplay {
  reason: string;
  beforeCount: number;
  afterCount: number;
  tokensReclaimed?: number;
  fallbackMode?: CompactionFallbackMode;
  at: number;
}
