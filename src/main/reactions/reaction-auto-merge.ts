/**
 * Auto-merge concern for the Reaction Engine.
 *
 * Isolated from the engine because auto-merge is the only destructive reaction:
 * keeping its guardrails (live re-fetch, precondition verification, audit) in a
 * dedicated module makes the safety logic easy to review and test in isolation.
 *
 * Permission gating (global enable + per-instance arming + the distinct
 * auto-merge opt-in) is enforced by the engine BEFORE `performAutoMerge` is
 * called. This module assumes permission has already been granted and is solely
 * responsible for confirming the PR is still safe to merge at fire time.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from '../logging/logger';
import { fetchPREnrichmentBatch } from '../vcs/remotes/github-pr-poller';
import { eventToReactionKey } from './reaction.types';
import type {
  InstanceReactionState,
  PREnrichmentData,
  ReactionEvent,
  ReactionEventPriority,
  ReactionEventType,
  ReactionResult,
} from './reaction.types';

const execFileAsync = promisify(execFile);
const logger = getLogger('ReactionAutoMerge');

export type AutoMergeOutcome = 'merged' | 'skipped' | 'failed';

/** Performs the actual merge. Injectable so the side effect is testable. */
export type MergeFn = (repo: string, prNumber: number) => Promise<void>;

/** Default merge implementation: squash + auto-merge via the authenticated `gh` CLI. */
const defaultGhMerge: MergeFn = async (repo, prNumber) => {
  await execFileAsync('gh', [
    'pr', 'merge', String(prNumber), '--squash', '--auto', '--repo', repo,
  ], { timeout: 30_000 });
};

export interface AutoMergeAuditSnapshot {
  instanceId: string;
  prUrl?: string;
  repo: string;
  prNumber: number;
  outcome: AutoMergeOutcome;
  reasons: string[];
  preconditions: {
    state: PREnrichmentData['state'];
    ciStatus: PREnrichmentData['ciStatus'];
    reviewDecision: PREnrichmentData['reviewDecision'];
    mergeable: boolean;
    hasConflicts: boolean;
  };
  timestamp: number;
}

/**
 * Engine callbacks the auto-merge flow needs. Passing them in (rather than the
 * whole engine) keeps the coupling explicit and the module unit-testable.
 */
export interface AutoMergeEngineContext {
  emitEvent(
    state: InstanceReactionState,
    eventType: ReactionEventType,
    data: PREnrichmentData,
    message: string,
  ): ReactionEvent;
  notifyHuman(event: ReactionEvent, priority: ReactionEventPriority): Promise<void>;
  emit(eventName: string, payload: unknown): void;
}

/**
 * Hard preconditions for an auto-merge. Verified at fire time against LIVE PR
 * state so a merge can never proceed on a PR that has since regressed.
 */
export function verifyMergePreconditions(d: PREnrichmentData): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (d.state !== 'open') reasons.push(`PR state is "${d.state}", expected "open"`);
  if (d.ciStatus !== 'passing') reasons.push(`CI status is "${d.ciStatus}", expected "passing"`);
  if (d.reviewDecision !== 'approved') reasons.push(`review decision is "${d.reviewDecision}", expected "approved"`);
  if (!d.mergeable) reasons.push('PR is not mergeable');
  if (d.hasConflicts) reasons.push('PR has merge conflicts');
  return { ok: reasons.length === 0, reasons };
}

export function buildAutoMergeAudit(
  state: InstanceReactionState,
  data: PREnrichmentData,
  outcome: AutoMergeOutcome,
  reasons: string[],
  now: number,
): AutoMergeAuditSnapshot {
  return {
    instanceId: state.instanceId,
    prUrl: state.prUrl,
    repo: `${data.owner}/${data.repo}`,
    prNumber: data.number,
    outcome,
    reasons,
    preconditions: {
      state: data.state,
      ciStatus: data.ciStatus,
      reviewDecision: data.reviewDecision,
      mergeable: data.mergeable,
      hasConflicts: data.hasConflicts,
    },
    timestamp: now,
  };
}

/**
 * Attempt to merge a PR using the `gh` CLI, with guardrails:
 *   1. Re-fetch LIVE PR state (never trust the stale poll snapshot).
 *   2. Verify hard preconditions (open, CI passing, approved, mergeable, no conflicts).
 *   3. Only then merge; audit the outcome (merged / skipped / failed) either way.
 */
export async function performAutoMerge(
  ctx: AutoMergeEngineContext,
  state: InstanceReactionState,
  eventType: ReactionEventType,
  staleData: PREnrichmentData,
  message: string,
  mergeFn: MergeFn = defaultGhMerge,
): Promise<ReactionResult> {
  const reactionKey = eventToReactionKey(eventType) ?? eventType;

  const audit = (data: PREnrichmentData, outcome: AutoMergeOutcome, reasons: string[]): void => {
    const snapshot = buildAutoMergeAudit(state, data, outcome, reasons, Date.now());
    logger.info('Auto-merge audit', { ...snapshot });
    ctx.emit('reaction:auto-merge-audit', snapshot);
  };

  const abort = async (data: PREnrichmentData, reasons: string[], userMessage: string): Promise<ReactionResult> => {
    audit(data, 'skipped', reasons);
    const event = ctx.emitEvent(state, eventType, data, userMessage);
    await ctx.notifyHuman(event, 'action');
    return { reactionType: reactionKey, success: false, action: 'auto-merge', message, escalated: false };
  };

  // 1. Re-fetch live state. If we cannot confirm it, do NOT merge.
  let fresh: PREnrichmentData;
  try {
    const batch = await fetchPREnrichmentBatch([
      { owner: staleData.owner, repo: staleData.repo, number: staleData.number },
    ]);
    const refreshed = batch.get(`${staleData.owner}/${staleData.repo}#${staleData.number}`);
    if (!refreshed) {
      return abort(staleData, ['could not re-fetch live PR state before merge'],
        `Auto-merge aborted: could not confirm live PR state. ${message}`);
    }
    fresh = refreshed;
  } catch (err) {
    return abort(staleData, [`could not re-fetch live PR state: ${(err as Error).message}`],
      `Auto-merge aborted: could not confirm live PR state. ${message}`);
  }

  // 2. Verify hard preconditions against the fresh snapshot.
  const check = verifyMergePreconditions(fresh);
  if (!check.ok) {
    return abort(fresh, check.reasons,
      `Auto-merge skipped — preconditions not met: ${check.reasons.join('; ')}. ${message}`);
  }

  // 3. Preconditions hold — merge.
  const repo = `${fresh.owner}/${fresh.repo}`;
  try {
    await mergeFn(repo, fresh.number);
    audit(fresh, 'merged', []);
    ctx.emit('reaction:auto-merged', { instanceId: state.instanceId, prNumber: fresh.number, repo });
    logger.info('Auto-merged PR via gh CLI', { repo, prNumber: fresh.number });
    return { reactionType: reactionKey, success: true, action: 'auto-merge', message, escalated: false };
  } catch (err) {
    audit(fresh, 'failed', [(err as Error).message]);
    const event = ctx.emitEvent(state, eventType, fresh, `Auto-merge failed for PR #${fresh.number}. ${message}`);
    await ctx.notifyHuman(event, 'action');
    return { reactionType: reactionKey, success: false, action: 'auto-merge', message, escalated: false };
  }
}
