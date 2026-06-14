/**
 * Campaign Mode Types
 *
 * A campaign is a directed acyclic graph (DAG) of loop specs.
 * Each node is a standard loop run; edges define sequencing and gating.
 *
 * The campaign orchestrator owns only choreography. Stop-logic authority
 * remains exclusively with each node's loop coordinator and evidence ladder.
 */

import type { LoopConfig } from './loop.types';

// -------------------------------------------------------------------------
// Terminal status predicate
// -------------------------------------------------------------------------

/** Terminal statuses a loop run can reach. */
export type LoopTerminalStatus =
  | 'completed'
  | 'completed-needs-review'
  | 'failed'
  | 'provider-limit'
  | 'operator-halted'
  | 'interrupted';

/**
 * Predicate on a loop's terminal status.
 * An edge only fires when the upstream node's terminal status satisfies this.
 * Default (undefined) = fire on any terminal status.
 */
export type TerminalStatusPredicate =
  | { type: 'is'; status: LoopTerminalStatus }
  | { type: 'in'; statuses: LoopTerminalStatus[] }
  | { type: 'not'; status: LoopTerminalStatus };

// -------------------------------------------------------------------------
// Campaign data model
// -------------------------------------------------------------------------

export interface CampaignNode {
  id: string;
  /** Human-readable label for this node in the DAG view. */
  label?: string;
  /** Full loop config for this node's run. */
  loopConfig: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string };
  /** IDs of nodes this one must wait for (resolved from edges). */
  dependsOn: string[];
}

export interface CampaignEdge {
  from: string;
  to: string;
  /**
   * Optional predicate. If omitted, the edge fires on any terminal status.
   * If the upstream node reaches terminal but does not satisfy this predicate,
   * the downstream node is skipped instead of started.
   */
  when?: TerminalStatusPredicate;
}

export type CampaignOnNodeNeedsReview = 'pause-campaign' | 'continue' | 'halt';

export interface CampaignPolicy {
  /**
   * What to do when a node reaches `completed-needs-review`.
   * - `pause-campaign`: halt all downstream nodes until operator accepts (default).
   * - `continue`: treat needs-review as completed and keep running downstream.
   * - `halt`: stop the entire campaign immediately.
   */
  onNodeNeedsReview: CampaignOnNodeNeedsReview;
  /**
   * Maximum number of loop nodes running concurrently.
   * Prevents unbounded parallel spawning. Default 3.
   */
  maxParallel: number;
  /**
   * If set, each node runs in its own git worktree to avoid conflicting
   * mutations. Reuses ParallelWorktreeCoordinator when more than one node runs.
   */
  isolation?: 'worktree';
}

export interface CampaignSpec {
  id: string;
  title: string;
  nodes: CampaignNode[];
  edges: CampaignEdge[];
  policy: CampaignPolicy;
  createdAt: number;
  /** Optional: external reference (PR URL, issue, plan file). */
  sourceRef?: string;
}

// -------------------------------------------------------------------------
// Campaign run state
// -------------------------------------------------------------------------

export type CampaignStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'halted';

export type CampaignNodeStatus =
  | 'pending'
  | 'running'
  | 'skipped'
  | 'completed'
  | 'completed-needs-review'
  | 'failed'
  | 'provider-limit'
  | 'operator-halted';

export interface CampaignNodeRun {
  nodeId: string;
  campaignId: string;
  status: CampaignNodeStatus;
  loopRunId?: string;
  startedAt?: number;
  endedAt?: number;
  skippedReason?: string;
}

export interface CampaignRun {
  id: string;
  spec: CampaignSpec;
  status: CampaignStatus;
  nodeRuns: Map<string, CampaignNodeRun>;
  startedAt: number;
  endedAt?: number;
  pausedReason?: string;
}

// -------------------------------------------------------------------------
// IPC data transfer shapes (no Maps; safe for JSON serialization)
// -------------------------------------------------------------------------

export interface CampaignNodeRunDto {
  nodeId: string;
  campaignId: string;
  status: CampaignNodeStatus;
  loopRunId?: string;
  startedAt?: number;
  endedAt?: number;
  skippedReason?: string;
}

export interface CampaignRunDto {
  id: string;
  spec: CampaignSpec;
  status: CampaignStatus;
  nodeRuns: CampaignNodeRunDto[];
  startedAt: number;
  endedAt?: number;
  pausedReason?: string;
}
