/**
 * The contracts between the Plan Queue coordinator, its item flow and the
 * instance manager. Kept apart so each side can be read (and faked) alone.
 */

import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { InstanceStatus } from '@contracts/types/instance-events';
import type { AccountPreferences, ContextUsage, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstanceTracker } from './plan-queue-instance-tracker';
import type { VerifierSelectInput, VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { InternalInputSource } from '../../shared/types/input-provenance.types';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueStore } from './plan-queue-store';

export interface PlanQueueInstanceRecord {
  id: string;
  status: InstanceStatus;
  outputBuffer: readonly { type: string; content: string }[];
  provider?: string;
  currentModel?: string;
  providerSessionId?: string;
  contextUsage?: Pick<ContextUsage, 'copilotUsage'>;
  /** The session's pool account / Copilot account, inherited by a run's workers. */
  accountProfileId?: string;
  copilotAccountProfileId?: string;
  /** Failover preferences from James's account rules; see `Instance.accountPreferences`. */
  accountPreferences?: AccountPreferences;
  workingDirectory?: string;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
  /** App-owned conversation identity; survives a restart that changes the id. */
  historyThreadId?: string;
  createdAt?: number;
}

/** The slice of InstanceManager that keeps a run's sessions nested under its parent. */
export interface PlanQueueSessionTreePort {
  getAllInstances(): PlanQueueInstanceRecord[];
  /** Refused while the child's current parent is live and not superseded. */
  adoptOrphanInstance(childId: string, parentId: string): boolean;

}

/** The slice of InstanceManager the queue drives. */
export interface PlanQueueInstancePort {
  createInstance(config: InstanceCreateConfig): Promise<{ id: string; readyPromise?: Promise<unknown>; queueResumed?: boolean }>;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: { automatedInput?: boolean; internalSource?: InternalInputSource },
  ): Promise<void>;
  terminateInstance(instanceId: string, graceful?: boolean): Promise<void>;
  /** Archive the provider conversation and start fresh while keeping the same owning instance ID. */
  restartFreshInstance(instanceId: string): Promise<string | undefined>;
  getInstance(instanceId: string): PlanQueueInstanceRecord | undefined;
  getAllInstances(): PlanQueueInstanceRecord[];
}

export type PlanQueueRoleRecord =
  | { role: 'worker' | 'verifier'; runId: string; itemId: string }
  | { role: 'triage'; runId: string };

/** What the flow needs from the coordinator. */
export interface PlanQueueFlowHost {
  readonly store: PlanQueueStore;
  readonly history: PlanQueueHistoryStore;
  checksAdmitted(run: PlanQueueRun): boolean;
  /** Stops new starts on a run, or clears that. Live work is not touched. */
  setRunHold(runId: string, holdReason: string | null): void;
  readonly instances: PlanQueueInstancePort;
  readonly worktrees: PlanQueueWorktreeService;
  readonly tracker: PlanQueueInstanceTracker;
  selectVerifier(input: VerifierSelectInput): Promise<VerifierSelection>;
  getRun(runId: string): PlanQueueRun;
  getItem(itemId: string): PlanQueueItem;
  /** Persist and announce. Throws on a failed write. */
  save(item: PlanQueueItem): PlanQueueItem;
  /** Assert the transition, then persist and announce. */
  transition(item: PlanQueueItem, to: PlanQueueItemState, patch?: Partial<PlanQueueItem>): PlanQueueItem;
  registerRole(instanceId: string, record: PlanQueueRoleRecord): void;
  unregisterRole(instanceId: string): void;
  roleOf(instanceId: string): PlanQueueRoleRecord | undefined;
  notifyParent(run: PlanQueueRun, message: string, questions?: readonly PlanQueueItem[]): void;
  /** The run's parent session, followed across a restart; undefined while it is gone. */
  liveParentId(run: PlanQueueRun): string | undefined;
  resolveRunParent(run: PlanQueueRun): string | undefined;

  /** Dev-app ports recorded on other items still in play (livetest port allocation). */
  livetestPortsInUse(exceptItemId: string): readonly number[];
  requestPump(): void;
  consumeUserClose?(instanceId: string): boolean;
}
