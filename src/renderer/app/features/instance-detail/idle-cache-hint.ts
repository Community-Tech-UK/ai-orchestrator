/**
 * The "Starting something new?" hint (Oct-2 T13.2): after 75 idle minutes at 100K or more,
 * a Claude session is cheaper to replace than to resume. The rules live in
 * `shared/utils/claude-cache-economics`; this file gathers what the renderer knows about the
 * session and keeps the hint quiet while anything is still expected to use it.
 */

import {
  decideIdleHint,
  trustedContextTokens,
  type IdleHintDecision,
} from '../../../../shared/utils/claude-cache-economics';
import type { Instance } from '../../core/state/instance/instance.types';

/** Matches the main-process tracker: a wake-up stays "pending" this long past its due time. */
const SELF_WAKEUP_GRACE_MS = 10 * 60_000;
const SELF_WAKEUP_SCAN_LIMIT = 200;

/**
 * Whether Claude asked to be woken (its own ScheduleWakeup) and that is still expected.
 * The main process leaves a notice in the transcript for each request; the newest decides.
 */
export function hasPendingSelfWakeup(
  messages: readonly { metadata?: Record<string, unknown> }[] | undefined,
  now: number,
): boolean {
  if (!messages) return false;
  const refused = new Set<string>();
  const oldest = Math.max(0, messages.length - SELF_WAKEUP_SCAN_LIMIT);
  for (let index = messages.length - 1; index >= oldest; index--) {
    const notice = messages[index]?.metadata?.['selfWakeup'];
    if (!notice || typeof notice !== 'object') continue;
    const { kind, toolUseId, dueAt } = notice as { kind?: unknown; toolUseId?: unknown; dueAt?: unknown };
    if (kind === 'stopped') return false; // cancelling clears everything requested before it
    if (typeof toolUseId !== 'string') continue;
    if (kind === 'refused') refused.add(toolUseId);
    else if (kind === 'requested' && !refused.has(toolUseId) && typeof dueAt === 'number'
      && now < dueAt + SELF_WAKEUP_GRACE_MS) return true;
  }
  return false;
}

export interface IdleHintFacts {
  instance: Pick<Instance, 'provider' | 'status' | 'lastActivity' | 'contextUsage' | 'waitReason' | 'backgroundWork'
    | 'pendingApprovalCount' | 'outputBuffer'>;
  /** An enabled scheduled wake-up is aimed at this session. */
  hasScheduledWakeUp: boolean;
  /** A loop attached to this session is running, paused or parked. */
  hasActiveLoop: boolean;
  now: number;
}

export function idleHintFor(facts: IdleHintFacts): IdleHintDecision {
  const { instance, now } = facts;
  return decideIdleHint({
    provider: instance.provider,
    status: instance.status,
    idleMs: now - instance.lastActivity,
    contextTokens: trustedContextTokens(instance.contextUsage),
    // A wait reason (quota park, backoff, sign-in) means something is already holding the session.
    wakeUpPending: facts.hasScheduledWakeUp || facts.hasActiveLoop || instance.waitReason !== undefined
      || hasPendingSelfWakeup(instance.outputBuffer, now),
    backgroundWorkPending: (instance.backgroundWork?.count ?? 0) > 0,
    dialogPending: (instance.pendingApprovalCount ?? 0) > 0,
  });
}
