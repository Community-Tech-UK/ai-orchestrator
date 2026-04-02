/**
 * Branded (nominal) ID types — compile-time safety with zero runtime cost.
 *
 * Prevents passing an InstanceId where a SessionId is expected, caught at compile time.
 *
 * Usage:
 *   function getSession(id: SessionId): Session { ... }
 *   getSession(toSessionId(rawString));  // OK
 *   getSession(instanceId);              // Compile error!
 */

declare const __brand: unique symbol;

/** Brand utility — intersects base type with a phantom brand field. */
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ── Core ID Types ──────────────────────────────────────────────

export type InstanceId = Brand<string, 'InstanceId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type AgentId = Brand<string, 'AgentId'>;

// ── Orchestration ID Types ─────────────────────────────────────

export type DebateId = Brand<string, 'DebateId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type ConsensusId = Brand<string, 'ConsensusId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type WorktreeId = Brand<string, 'WorktreeId'>;

// ── Resource ID Types ──────────────────────────────────────────

export type TaskId = Brand<string, 'TaskId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type ServerId = Brand<string, 'ServerId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

// ── Hierarchy ID Types ─────────────────────────────────────────

export type SupervisorNodeId = Brand<string, 'SupervisorNodeId'>;
export type WorkerNodeId = Brand<string, 'WorkerNodeId'>;

// ── Factory Functions (zero-cost casts) ────────────────────────

export function toInstanceId(raw: string): InstanceId { return raw as InstanceId; }
export function toSessionId(raw: string): SessionId { return raw as SessionId; }
export function toAgentId(raw: string): AgentId { return raw as AgentId; }
export function toDebateId(raw: string): DebateId { return raw as DebateId; }
export function toVerificationId(raw: string): VerificationId { return raw as VerificationId; }
export function toConsensusId(raw: string): ConsensusId { return raw as ConsensusId; }
export function toReviewId(raw: string): ReviewId { return raw as ReviewId; }
export function toWorktreeId(raw: string): WorktreeId { return raw as WorktreeId; }
export function toTaskId(raw: string): TaskId { return raw as TaskId; }
export function toSkillId(raw: string): SkillId { return raw as SkillId; }
export function toServerId(raw: string): ServerId { return raw as ServerId; }
export function toSnapshotId(raw: string): SnapshotId { return raw as SnapshotId; }
export function toWorkflowId(raw: string): WorkflowId { return raw as WorkflowId; }
export function toArtifactId(raw: string): ArtifactId { return raw as ArtifactId; }
export function toSupervisorNodeId(raw: string): SupervisorNodeId { return raw as SupervisorNodeId; }
export function toWorkerNodeId(raw: string): WorkerNodeId { return raw as WorkerNodeId; }

/** Union of all branded ID types — useful for generic ID parameters. */
export type AnyId = InstanceId | SessionId | AgentId | DebateId
  | VerificationId | ConsensusId | ReviewId | WorktreeId
  | TaskId | SkillId | ServerId | SnapshotId | WorkflowId | ArtifactId
  | SupervisorNodeId | WorkerNodeId;
