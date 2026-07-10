/**
 * Shared types, constants, and small pure helpers for the interrupt/respawn
 * handler. Split out of interrupt-respawn-handler.ts to keep that module focused
 * on the interrupt lifecycle logic.
 */
import type {
  ContextUsage,
  Instance,
  InstanceStatus,
  InstanceWaitReason,
  SessionDiffStats,
} from '../../../shared/types/instance.types';
import type { ActivityState } from '../../../shared/types/activity.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { ErrorInfo } from '../../../shared/types/ipc.types';

export type QueueUpdate = (
  instanceId: string,
  status: InstanceStatus,
  contextUsage?: ContextUsage,
  diffStats?: SessionDiffStats | null,
  displayName?: string,
  error?: ErrorInfo,
  executionLocation?: ExecutionLocation,
  sessionState?: {
    providerSessionId?: string;
    restartEpoch?: number;
    adapterGeneration?: number;
    activeTurnId?: string;
    interruptRequestId?: string;
    interruptRequestedAt?: number;
    interruptPhase?: Instance['interruptPhase'];
    lastTurnOutcome?: Instance['lastTurnOutcome'];
    supersededBy?: string;
    cancelledForEdit?: boolean;
    recoveryMethod?: Instance['recoveryMethod'];
    archivedUpToMessageId?: string;
    historyThreadId?: string;
  },
  activityState?: ActivityState,
  currentModel?: string,
  waitReason?: InstanceWaitReason | null,
) => void;

/** How long to wait for a graceful interrupt to settle before force-aborting. */
export const INTERRUPT_FORCE_ABORT_MS = 30_000;
/** Deadline for `handleInterruptCompletion()` to receive a provider completion. */
export const INTERRUPT_COMPLETION_DEADLINE_MS = 15_000;

export function residentClaudeForSpawn(instance: Instance): boolean {
  if (instance.residentClaude !== true) {
    instance.residentClaude = true;
  }
  return true;
}
