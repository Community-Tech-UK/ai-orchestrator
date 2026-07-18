import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import type { Automation, AutomationRun } from '../../../../shared/types/automation.types';
import type { RepoJobRecord } from '../../../../shared/types/repo-job.types';
import type { WorkflowLifecyclePhase } from '../../../../shared/types/workflow-lifecycle.types';

/**
 * Renderer-local Workboard view model.
 *
 * The Workboard is a pure projection over the four authoritative source domains
 * (instances, loop runs, automation runs, repository jobs). These types are
 * deliberately renderer-local — they are not added to a shared transport
 * contract in this delivery, but they stay transport-neutral (no signals, no
 * Angular, no DOM) so a thin client could adopt the same projection later.
 */

/** The four attention lanes, in fixed display order. */
export type WorkboardLane = 'needs-you' | 'working' | 'waiting' | 'done';

/** Fixed lane order for headings and iteration. */
export const WORKBOARD_LANE_ORDER: readonly WorkboardLane[] = [
  'needs-you',
  'working',
  'waiting',
  'done',
] as const;

/** Which source domain a record came from. */
export type WorkboardSourceKind = 'repo-job' | 'automation-run' | 'loop-run' | 'instance';

/**
 * One source record that participated in a correlated item. Every relation
 * retains its raw source status and the coarse `WorkflowLifecyclePhase` so
 * display and future clients never lose the domain-specific meaning.
 */
export interface WorkboardRelation {
  kind: WorkboardSourceKind;
  id: string;
  rawStatus: string;
  phase: WorkflowLifecyclePhase;
  lane: WorkboardLane;
  updatedAt: number;
  /** True when this relation has reached a terminal, non-resumable state.
   *  Drives the 24-hour recent-terminal retention window. */
  terminal: boolean;
}

/**
 * A correlated unit of work. The `primary` relation supplies the title and the
 * specialist destination; related records supply live status, attention,
 * transcript linkage, and secondary metadata. `lane` is the most urgent lane
 * across all relations.
 */
export interface WorkboardItem {
  /** Stable id derived from the primary source kind + id. */
  id: string;
  primary: WorkboardRelation;
  relations: readonly WorkboardRelation[];
  lane: WorkboardLane;
  title: string;
  workspaceId: string;
  workingDirectory: string;
  /** Friendly attention/status label; the raw status stays on `primary.rawStatus`. */
  statusLabel: string;
  /** Optional concise progress text, e.g. "Iteration 4" or an instance activity. */
  detail?: string;
  /** Optional numeric percentage (repository jobs only). */
  progress?: number;
  /** Optional error text for the source-summary pane. */
  errorText?: string;
  /** Optional output summary for the source-summary pane. */
  outputSummary?: string;
  updatedAt: number;
  /** Linkage carried for transcript selection and specialist navigation. */
  instanceId?: string;
  loopRunId?: string;
  automationRunId?: string;
  repoJobId?: string;
}

/** A workspace choice for the filter control. */
export interface WorkboardWorkspaceOption {
  /** Normalized workspace id from `toWorkspaceId(workingDirectory)`. */
  id: string;
  /** Human label based on the directory basename. */
  label: string;
  /** Full path for secondary text and accessible labeling. */
  workingDirectory: string;
}

/**
 * Minimal structural view of a renderer instance the projection needs. The full
 * `Instance` type is assignable to this subset, so the store can pass instances
 * straight through without adapting them.
 */
export interface WorkboardInstanceInput {
  id: string;
  status: InstanceStatus;
  displayName: string;
  workingDirectory: string;
  provider: string;
  lastActivity: number;
  currentActivity?: string;
}

/** Immutable input to the pure projection. `now` is injected for determinism. */
export interface WorkboardProjectionInput {
  instances: readonly WorkboardInstanceInput[];
  loopRuns: readonly LoopRunSummaryPayload[];
  automationRuns: readonly AutomationRun[];
  /** Owning automations, used only to recover a run's workspace when its
   *  `configSnapshot` is absent. */
  automations: readonly Automation[];
  repoJobs: readonly RepoJobRecord[];
  now: number;
}

/** Lane arrays keyed by lane. Every lane is always present (possibly empty). */
export type WorkboardLanes = Record<WorkboardLane, WorkboardItem[]>;
