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

// ── Orchestration ID Types ─────────────────────────────────────

export type DebateId = Brand<string, 'DebateId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type ConsensusId = Brand<string, 'ConsensusId'>;
export type WorktreeId = Brand<string, 'WorktreeId'>;

// ── Channel ID Types ──────────────────────────────────────────

export type ChatId = Brand<string, 'ChatId'>;

// ── Factory Functions (zero-cost casts) ────────────────────────

export function toInstanceId(raw: string): InstanceId { return raw as InstanceId; }
export function toSessionId(raw: string): SessionId { return raw as SessionId; }
export function toDebateId(raw: string): DebateId { return raw as DebateId; }
export function toVerificationId(raw: string): VerificationId { return raw as VerificationId; }
export function toConsensusId(raw: string): ConsensusId { return raw as ConsensusId; }
export function toWorktreeId(raw: string): WorktreeId { return raw as WorktreeId; }
export function toChatId(raw: string): ChatId { return raw as ChatId; }
