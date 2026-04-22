export type LaneLifecycleEventType =
  | 'lane.created'
  | 'lane.started'
  | 'lane.conflict_warning'
  | 'lane.merging'
  | 'lane.completed'
  | 'lane.failed'
  | 'lane.cancelled';

export type WorktreeLifecycleEventType =
  | 'worktree.created'
  | 'worktree.completed'
  | 'worktree.conflict_detected'
  | 'worktree.cleaned';

export type BranchLifecycleEventType =
  | 'branch.prepared'
  | 'branch.merge_succeeded'
  | 'branch.merge_failed';

export type LaneEventType =
  | LaneLifecycleEventType
  | WorktreeLifecycleEventType
  | BranchLifecycleEventType;

export interface LaneEventMetadata {
  executionId: string;
  taskId?: string;
  sessionId?: string;
  branchName?: string;
  worktreePath?: string;
}
