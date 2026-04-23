import { EventEmitter } from 'events';
import type { TaskPreflightSurface } from '../../shared/types/task-preflight.types';
import { createDetectedFailure, type DetectedFailure } from '../../shared/types/error-recovery.types';
import type { BranchFreshnessReport, BranchFreshnessState } from './branch-freshness';

export type StaleBranchPolicyAction = 'allow' | 'warn' | 'block';
export type StaleBranchRemediation = 'none' | 'set-upstream' | 'merge-forward' | 'rebase';

export interface StaleBranchPolicyContext {
  workingDirectory?: string;
  surface?: TaskPreflightSurface;
  taskType?: string;
  requiresWrite?: boolean;
}

export interface StaleBranchPolicyDecision {
  state: BranchFreshnessState;
  action: StaleBranchPolicyAction;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  summary: string;
  recommendedRemediation: StaleBranchRemediation;
  requiresManualResolution: boolean;
  failure?: DetectedFailure<'stale_branch'>;
}

export interface StaleBranchPolicyDecisionEvent {
  occurredAt: number;
  context: StaleBranchPolicyContext;
  decision: StaleBranchPolicyDecision;
}

function createFailure(
  report: BranchFreshnessReport,
  decision: Pick<StaleBranchPolicyDecision, 'action' | 'recommendedRemediation'>,
  context: StaleBranchPolicyContext,
): DetectedFailure<'stale_branch'> {
  return createDetectedFailure({
    id: `stale-branch:${report.branch ?? 'head'}:${Date.now()}`,
    category: 'stale_branch',
    instanceId: context.workingDirectory ?? report.branch ?? 'unknown-worktree',
    detectedAt: Date.now(),
    context: {
      branch: report.branch,
      upstream: report.upstream,
      ahead: report.ahead,
      behind: report.behind,
      state: report.state,
      summary: report.summary,
      action: decision.action,
      recommendedRemediation: decision.recommendedRemediation,
      surface: context.surface,
      taskType: context.taskType,
      workingDirectory: context.workingDirectory,
      requiresWrite: context.requiresWrite,
    },
  });
}

function remediationForState(state: BranchFreshnessState): StaleBranchRemediation {
  switch (state) {
    case 'no_upstream':
      return 'set-upstream';
    case 'stale':
      return 'merge-forward';
    case 'diverged':
      return 'rebase';
    default:
      return 'none';
  }
}

export class StaleBranchPolicy extends EventEmitter {
  evaluate(
    report: BranchFreshnessReport,
    context: StaleBranchPolicyContext = {},
  ): StaleBranchPolicyDecision {
    const action = this.actionFor(report.state);
    const recommendedRemediation = remediationForState(report.state);
    const requiresManualResolution = action !== 'allow' && recommendedRemediation !== 'none';
    const failure = action === 'allow'
      ? undefined
      : createFailure(report, { action, recommendedRemediation }, context);

    const decision: StaleBranchPolicyDecision = {
      state: report.state,
      action,
      branch: report.branch,
      upstream: report.upstream,
      ahead: report.ahead,
      behind: report.behind,
      summary: report.summary,
      recommendedRemediation,
      requiresManualResolution,
      failure,
    };

    this.emit('decision', {
      occurredAt: Date.now(),
      context,
      decision,
    } satisfies StaleBranchPolicyDecisionEvent);

    return decision;
  }

  private actionFor(state: BranchFreshnessState): StaleBranchPolicyAction {
    switch (state) {
      case 'diverged':
        return 'block';
      case 'stale':
      case 'no_upstream':
        return 'warn';
      case 'fresh':
      case 'not_repo':
      default:
        return 'allow';
    }
  }
}

let staleBranchPolicy: StaleBranchPolicy | null = null;

export function getStaleBranchPolicy(): StaleBranchPolicy {
  if (!staleBranchPolicy) {
    staleBranchPolicy = new StaleBranchPolicy();
  }
  return staleBranchPolicy;
}

export function _resetStaleBranchPolicyForTesting(): void {
  staleBranchPolicy = null;
}
