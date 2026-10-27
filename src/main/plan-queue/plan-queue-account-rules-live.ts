/**
 * Applies James's account rules to the Plan Queue sessions already running.
 *
 * A change takes effect at once. Every live queue session gets the new lists
 * (failover and handoffs read them from the session), and a session on an
 * account now on the never-use list has its work held: the same hold Pause
 * uses, so the worktree and branch are kept and the queue restarts the work on
 * an allowed account. Other documents are untouched. Adding a use-last rule
 * stops nothing; it applies to the next session.
 */

import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import type { AccountPreferences } from '../../shared/types/instance.types';
import { accountPreferencesFor, accountRuleTier, NEVER_USE_HOLD_REASON } from './plan-queue-account-rules';
import type { PlanQueueInstanceRecord, PlanQueueRoleRecord } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

/** A running Plan Queue session, as far as the account rules care. */
export interface LiveQueueSession {
  id: string;
  provider?: string;
  accountProfileId?: string;
  copilotAccountProfileId?: string;
  accountPreferences?: AccountPreferences;
}

/** The coordinator's side of a rule change: what it can see and do. */
export interface LiveAccountRulesHost {
  liveSessions(): LiveQueueSession[];
  /** Set the session's preferences on the live instance, and persist them. */
  setPreferences(instanceId: string, preferences: AccountPreferences | undefined): void;
  /** Hold the work the session is doing (its item, or its run's triage). Resolves once held. */
  holdSession(instanceId: string, reason: string): Promise<void>;
  requestPump(): void;
}

/** The rule-change source and the persistence the coordinator is given. */
export interface PlanQueueAccountRulesPort {
  /** Calls `listener` with the lists whenever James saves them. Returns the unsubscribe. */
  onChanged(listener: (rules: PlanQueueAccountRules) => void): () => void;
  /** Write a live session's preferences to its saved session state. */
  persistPreferences(instanceId: string, preferences: AccountPreferences | undefined): void;
}

/**
 * Whether an item still runs on this session when the hold is applied. A hold for
 * a landing item waits for the landing to finish (see PlanQueueItemFlow.hold): a
 * landed item has nothing left to stop, and a landing that falls back to fixing
 * has its worker stopped.
 */
export function stillRunsOn(instanceId: string): (item: PlanQueueItem) => boolean {
  return (current) => current.workerInstanceId === instanceId || current.verifierInstanceId === instanceId;
}

/** Whether the account a session is on has been put on the never-use list. */
export function sessionOnNeverUse(session: LiveQueueSession, rules: PlanQueueAccountRules): boolean {
  if (!session.provider) return false;
  const account = session.provider === 'copilot' ? session.copilotAccountProfileId : session.accountProfileId;
  return account !== undefined && accountRuleTier(rules, session.provider, account) === 'never';
}

/** What the coordinator provides to act on the sessions it runs. */
export interface QueueSessionsPort {
  getAllInstances(): PlanQueueInstanceRecord[];
  getInstance(instanceId: string): PlanQueueInstanceRecord | undefined;
  isQueueInstance(instanceId: string): boolean;
  roleOf(instanceId: string): PlanQueueRoleRecord | undefined;
  /** The worker or checker item running on this session, if any. */
  itemFor(instanceId: string): PlanQueueItem | undefined;
  pauseTriage(runId: string): Promise<void> | undefined;
  hold(itemId: string, reason: string, stillHeld: (item: PlanQueueItem) => boolean): Promise<void>;
  requestPump(): void;
  persistPreferences?: (instanceId: string, preferences: AccountPreferences | undefined) => void;
}

export function liveQueueSessionsHost(port: QueueSessionsPort): LiveAccountRulesHost {
  return {
    liveSessions: () => port.getAllInstances().filter((instance) => port.isQueueInstance(instance.id)),
    setPreferences: (instanceId, preferences) => {
      const instance = port.getInstance(instanceId);
      if (!instance) return;
      instance.accountPreferences = preferences;
      port.persistPreferences?.(instanceId, preferences);
    },
    holdSession: async (instanceId, reason) => {
      const role = port.roleOf(instanceId);
      if (role?.role === 'triage') {
        await port.pauseTriage(role.runId);
        return;
      }
      const item = port.itemFor(instanceId);
      if (item) await port.hold(item.id, reason, stillRunsOn(instanceId));
    },
    requestPump: () => port.requestPump(),
  };
}

export async function applyLiveAccountRules(rules: PlanQueueAccountRules, host: LiveAccountRulesHost): Promise<void> {
  const banned: LiveQueueSession[] = [];
  for (const session of host.liveSessions()) {
    if (!session.provider) continue;
    const preferences = accountPreferencesFor(rules, session.provider) ?? undefined;
    if (JSON.stringify(session.accountPreferences ?? null) !== JSON.stringify(preferences ?? null)) {
      host.setPreferences(session.id, preferences);
    }
    if (sessionOnNeverUse(session, rules)) banned.push(session);
  }
  // Each hold waits for its own item lock (and any landing in progress); the holds do not wait on each other.
  // Wait for every hold, so a failed one neither hides the others nor starts the restart early.
  const results = await Promise.allSettled(banned.map((session) => host.holdSession(session.id, NEVER_USE_HOLD_REASON)));
  if (banned.length > 0) host.requestPump();
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
