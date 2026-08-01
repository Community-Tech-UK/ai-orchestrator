/**
 * WS-C2 unified attention scale.
 *
 * ONE ordered urgency scale, computed from the EXISTING per-domain status
 * enums (instance, loop run, automation run, repository job) that Workboard,
 * the session picker, and the mobile gateway already read. Each surface may
 * choose its own display label, grouping, or chip styling, but the ORDER and
 * SEMANTICS of "how urgent is this" come from here so the same item never
 * shows a different urgency in two places.
 *
 * `blocked` is reserved for a live, answerable question — the item is
 * actively waiting on a yes/no/select/text response right now. `failed` is a
 * terminal or degraded state that needs attention but has no single
 * "answer this" action. `review` is a successful-but-flagged outcome
 * (currently only the loop's `completed-needs-review`). This split exists
 * (rather than one merged "needs you" bucket) because act-from-the-card only
 * makes sense for `blocked` items — a failed run has no button that fixes it.
 *
 * Extension point: WS-B1 phase 2 (PR-derived states) does not exist yet.
 * When it lands, add its states to the relevant `attentionLevelForXxx`
 * function below — do not invent placeholder PR states here.
 */

import type { InstanceStatus } from '@contracts/types/instance-events';
import type { LoopStatus } from '../types/loop.types';
import type { AutomationRunStatus } from '../types/automation.types';
import type { RepoJobStatus } from '../types/repo-job.types';

/** Ordered urgency scale, most urgent first. */
export type AttentionLevel = 'blocked' | 'failed' | 'review' | 'waiting' | 'working' | 'idle';

/** Fixed rank order — index 0 is the most urgent. Every consumer must use
 *  this order rather than re-deriving one, so ordering never drifts across
 *  surfaces. */
export const ATTENTION_LEVEL_ORDER: readonly AttentionLevel[] = [
  'blocked',
  'failed',
  'review',
  'waiting',
  'working',
  'idle',
];

const ATTENTION_RANK: Record<AttentionLevel, number> = Object.fromEntries(
  ATTENTION_LEVEL_ORDER.map((level, index) => [level, index]),
) as Record<AttentionLevel, number>;

function assertNever(value: never): never {
  throw new Error(`Unhandled attention input: ${String(value)}`);
}

/** The most urgent level across a set of levels (`blocked` wins over everything). */
export function mostUrgentAttentionLevel(levels: readonly AttentionLevel[]): AttentionLevel {
  return levels.reduce(
    (best, level) => (ATTENTION_RANK[level] < ATTENTION_RANK[best] ? level : best),
    'idle' as AttentionLevel,
  );
}

/** True when `a` is at least as urgent as `b` (lower rank = more urgent). */
export function isAtLeastAsUrgent(a: AttentionLevel, b: AttentionLevel): boolean {
  return ATTENTION_RANK[a] <= ATTENTION_RANK[b];
}

/**
 * Every `InstanceStatus`, for callers that need to derive a status-keyed
 * `Set`/lookup from the attention scale (e.g. the mobile gateway's
 * `WORKING_STATUSES` / `WAITING_STATUSES`) instead of hand-duplicating the
 * enum. Kept in sync with `@contracts/types/instance-events` by the
 * exhaustive switch in `attentionLevelForInstanceStatus` below — a missing
 * or stale entry here is caught by `attention-level.spec.ts`'s
 * "covers every InstanceStatus exactly once" test.
 */
export const ALL_INSTANCE_STATUSES: readonly InstanceStatus[] = [
  'initializing',
  'ready',
  'idle',
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'cancelled',
  'superseded',
  'respawning',
  'hibernating',
  'hibernated',
  'waking',
  'degraded',
  'error',
  'failed',
  'terminated',
];

/**
 * Instance status → attention level. Mirrors the instance side of
 * `instanceStatusToLane` in workboard-projection.ts, but splits its
 * `needs-you` bucket into `blocked` (a live permission/input prompt) and
 * `failed` (degraded/error/failed — no single answerable action).
 */
export function attentionLevelForInstanceStatus(status: InstanceStatus): AttentionLevel {
  switch (status) {
    case 'waiting_for_permission':
    case 'waiting_for_input':
      return 'blocked';
    case 'degraded':
    case 'error':
    case 'failed':
      return 'failed';
    case 'initializing':
    case 'busy':
    case 'processing':
    case 'thinking_deeply':
    case 'respawning':
    case 'waking':
    case 'interrupting':
    case 'cancelling':
    case 'interrupt-escalating':
      return 'working';
    case 'hibernating':
    case 'hibernated':
      return 'waiting';
    case 'ready':
    case 'idle':
    case 'terminated':
    case 'cancelled':
    case 'superseded':
      return 'idle';
    default:
      return assertNever(status);
  }
}

/**
 * Loop status → attention level. `provider-limit` keeps the existing
 * `endedAt`-based split: a null end is a resumable park (`waiting`), a set
 * end is a terminal state nothing can resume (`failed`).
 */
export function attentionLevelForLoopStatus(
  status: LoopStatus,
  endedAt: number | null,
): AttentionLevel {
  switch (status) {
    case 'running':
      return 'working';
    case 'paused':
      return 'waiting';
    case 'provider-limit':
      return endedAt === null ? 'waiting' : 'failed';
    case 'completed-needs-review':
      return 'review';
    case 'failed':
    case 'error':
    case 'no-progress':
    case 'cap-reached':
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable':
      return 'failed';
    case 'completed':
    case 'cancelled':
      return 'idle';
    default:
      return assertNever(status);
  }
}

/** Automation-run status → attention level. */
export function attentionLevelForAutomationRunStatus(status: AutomationRunStatus): AttentionLevel {
  switch (status) {
    case 'running':
      return 'working';
    case 'pending':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'succeeded':
    case 'skipped':
    case 'cancelled':
      return 'idle';
    default:
      return assertNever(status);
  }
}

/** Repository-job status → attention level. */
export function attentionLevelForRepoJobStatus(status: RepoJobStatus): AttentionLevel {
  switch (status) {
    case 'running':
      return 'working';
    case 'queued':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'cancelled':
      return 'idle';
    default:
      return assertNever(status);
  }
}
