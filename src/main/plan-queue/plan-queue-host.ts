/**
 * The contracts between the Plan Queue coordinator, its item flow and the
 * instance manager. Kept apart so each side can be read (and faked) alone.
 */

import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { InstanceStatus } from '@contracts/types/instance-events';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstanceTracker } from './plan-queue-instance-tracker';
import type { VerifierSelectInput, VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { InternalInputSource } from '../../shared/types/input-provenance.types';

export interface PlanQueueInstanceRecord {
  id: string;
  status: InstanceStatus;
  outputBuffer: readonly { type: string; content: string }[];
  provider?: string;
  currentModel?: string;
  workingDirectory?: string;
  metadata?: Record<string, unknown>;
}

/** The slice of InstanceManager the queue drives. */
export interface PlanQueueInstancePort {
  createInstance(config: InstanceCreateConfig): Promise<{ id: string; readyPromise?: Promise<unknown> }>;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: { automatedInput?: boolean; internalSource?: InternalInputSource },
  ): Promise<void>;
  terminateInstance(instanceId: string, graceful?: boolean): Promise<void>;
  getInstance(instanceId: string): PlanQueueInstanceRecord | undefined;
}

export type PlanQueueRoleRecord =
  | { role: 'worker' | 'verifier'; runId: string; itemId: string }
  | { role: 'triage'; runId: string };

/** What the flow needs from the coordinator. */
export interface PlanQueueFlowHost {
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
  notifyParent(run: PlanQueueRun, message: string): void;
  requestPump(): void;
}
