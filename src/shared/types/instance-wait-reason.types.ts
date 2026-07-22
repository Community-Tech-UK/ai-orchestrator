/**
 * Why an instance is currently waiting, surfaced to the renderer so a long
 * silent spinner always has a reason (and, where known, a deadline/ETA). The
 * status alone can't express "waiting for a provider slot until T" or
 * "backing off, retry at T" — this union fills that gap (plan §4.G / E1/E2/D7).
 * `startedAt`/`deadlineAt`/`resumeAt`/`retryAt` are epoch-ms timestamps.
 *
 * Split out of `instance.types.ts` (which sits at its size ceiling) so the
 * union has room to be documented as it grows. Re-exported from there, so
 * existing `import { InstanceWaitReason } from './instance.types'` keeps
 * working.
 */
export type InstanceWaitReason =
  | { kind: 'provider-slot'; provider: string; startedAt: number; deadlineAt?: number }
  | { kind: 'interrupt-ack'; startedAt: number; deadlineAt?: number; attempt: number }
  | { kind: 'terminating'; force: boolean; startedAt: number; deadlineAt?: number }
  | { kind: 'respawning'; strategy: 'native-resume' | 'fresh-replay'; startedAt: number }
  | { kind: 'resume-proof'; provider: string; sessionId?: string; startedAt: number; deadlineAt?: number }
  | { kind: 'remote-heartbeat'; nodeId: string; remoteTurnId?: string; staleForMs: number }
  | { kind: 'mutex'; operation: string; owner?: string; startedAt: number }
  /** Parked on a provider quota window; auto-resumes by `resumeAt` at the latest. */
  | { kind: 'quota-park'; provider: string; resumeAt: number }
  /**
   * The provider signed us out mid-session. Unlike `quota-park` there is no
   * deadline: it clears when the user signs back in (detected automatically
   * for providers with an auth probe) or dismisses the banner. Set by
   * `instance-auth-repair-handler.ts`.
   */
  | { kind: 'auth-required'; provider: string; since: number }
  | { kind: 'backoff'; attempt: number; retryAt: number };
