/**
 * Plain-English help for every way a Plan Queue job can be set aside.
 *
 * One table, exhaustive over the contract's park-reason enum (the `Record`
 * type makes a new reason a compile error here), so no reason can ship without
 * words. The presenter also relabels historical rows here — never by rewriting
 * the stored data.
 */
import type { PlanQueueItemDto, PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { stripAbsolutePaths } from './plan-queue-item-display';

/** The buttons a set-aside card may show; only the ones a reason applies to. */
export type PlanQueueParkAction =
  | 'see-findings'
  | 'choose-checker'
  | 'resume'
  | 'retry-landing'
  | 'merge-without-checks'
  | 'discard';

export interface PlanQueueParkReasonHelp {
  /** The headline under the card's "Set aside". */
  label: string;
  /** What the reason means, in plain English. */
  meaning: string;
  /** What James can do next. */
  next: string;
  /** Buttons that apply to this reason — and only these render. */
  actions: readonly PlanQueueParkAction[];
}

export const PARK_REASON_HELP: Record<PlanQueueParkReason, PlanQueueParkReasonHelp> = {
  'round-limit': {
    label: 'Ran out of rounds',
    meaning: 'Ran out of all the rounds before the work passed its checks.',
    next: 'See what the checker found, then Resume for another round or Merge without checks if the findings are wrong.',
    actions: ['see-findings', 'resume', 'merge-without-checks', 'discard'],
  },
  'verifier-unreliable': {
    label: 'The checker stopped without giving a verdict',
    meaning: 'The checker ended twice without reporting a result, so there is nothing to judge the work on.',
    next: 'Resume queues it for a fresh check, on another checker when one is available.',
    actions: ['resume', 'discard'],
  },
  'no-diverse-verifier': {
    label: 'No second model is allowed to check this',
    meaning: 'The rules for this folder or account say the model that wrote this work may not judge it, and no other model is allowed to.',
    next: 'Choose a checker that is allowed here, then Resume.',
    actions: ['choose-checker', 'resume', 'discard'],
  },
  'worker-error': {
    label: 'The worker stopped with an error',
    meaning: 'The worker session ended with an error instead of a result.',
    next: 'Resume puts it back in the queue for a new worker round.',
    actions: ['resume', 'discard'],
  },
  'triage-failed': {
    label: "Couldn't check if it's ready",
    meaning: 'Harness could not run the readiness check, so it never decided whether work should start.',
    next: 'Resume starts work on it without the readiness check.',
    actions: ['resume', 'discard'],
  },
  'worktree-error': {
    label: "Couldn't set up its working copy",
    meaning: 'Harness could not create or use the folder this job works in.',
    next: 'Resume tries to set the working copy up again.',
    actions: ['resume', 'discard'],
  },
  'merge-conflict': {
    label: 'Merge clash to resolve',
    meaning: 'The latest main and this branch changed the same lines.',
    next: 'Resume merges main again; if the clash returns, resolve it in the working copy first.',
    actions: ['resume', 'discard'],
  },
  'land-blocked': {
    label: "Couldn't merge",
    meaning: 'The merge onto main was blocked, even though the work itself is done.',
    next: 'Try merging again once what blocked it is gone, or Merge without checks if you accept landing without them.',
    actions: ['retry-landing', 'merge-without-checks', 'resume', 'discard'],
  },
  'provider-limit': {
    label: 'Usage limit reached',
    meaning: "The provider's usage limit stopped the session.",
    next: 'Resume once the usage limit resets.',
    actions: ['resume', 'discard'],
  },
  cancelled: {
    label: 'Stopped before it finished',
    meaning: 'Its run was cancelled while this document still had work left.',
    next: 'Resume puts it back in the queue.',
    actions: ['resume', 'discard'],
  },
  'restart-loop': {
    label: 'Restarted 3 times without progress',
    meaning: 'The job was restarted after an app restart three times and never finished a round.',
    next: 'Check its saved work, then Resume to try again.',
    actions: ['resume', 'discard'],
  },
  'no-progress': {
    label: 'Nothing changed since the last check failed',
    meaning: 'The worktree and the document were unchanged after a failed check, so another check would find the same problems.',
    next: 'Resume asks the worker for a real change.',
    actions: ['resume', 'discard'],
  },
  'stuck-on-same-finding': {
    label: 'The same finding keeps failing',
    meaning: 'The same check finding failed in several rounds.',
    next: 'Read the finding and its evidence, then Resume with new instructions, or Merge without checks if the finding is wrong.',
    actions: ['see-findings', 'resume', 'merge-without-checks', 'discard'],
  },
  'check-hung': {
    label: 'The checks keep running out of time',
    meaning: 'The checks did not finish twice in a row on the same work, so this may be a test that hangs. Other test runs on this computer can also cause it.',
    next: 'Open the details to see how far the last run got. Resume sends it back to a worker and then checks it again.',
    actions: ['resume', 'discard'],
  },
  'missing-document': {
    label: 'The document is gone',
    meaning: 'The source document is missing and has no exact completed replacement.',
    next: 'Restore the document (or its exact completed replacement), then Resume.',
    actions: ['resume', 'discard'],
  },
  'stopped-by-harness': {
    label: 'Harness stopped this job',
    meaning: 'Harness stopped the job to protect the machine or its own limits.',
    next: 'Read the details for the stop reason, then Resume to run it again.',
    actions: ['resume', 'discard'],
  },
};

/**
 * The old readiness-classification step (the first triage, replaced on 15
 * October) parked its failures as `worker-error` with one of these stored
 * details. The presenter relabels those rows; the stored data is never edited.
 */
export const HISTORICAL_CLASSIFICATION_DETAIL_PREFIXES: readonly string[] = [
  'Triage could not classify this document after two attempts',
  'Triage could not start (',
  'Source document is missing and has no exact completed replacement:',
];

export function isHistoricalClassificationDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return HISTORICAL_CLASSIFICATION_DETAIL_PREFIXES.some((prefix) => detail.startsWith(prefix));
}

export function planQueueParkReasonHelp(reason: PlanQueueParkReason | null): PlanQueueParkReasonHelp | null {
  return reason ? PARK_REASON_HELP[reason] ?? null : null;
}

/** The headline for a set-aside reason, with the round numbers where they apply. */
export function planQueueParkReasonLabel(
  reason: PlanQueueParkReason | null,
  options: { round?: number; maxRounds?: number } = {},
): string {
  if (!reason) return '';
  if (reason === 'round-limit' && options.round !== undefined && options.maxRounds !== undefined) {
    return `Ran out of rounds (${options.round} of ${options.maxRounds})`;
  }
  return PARK_REASON_HELP[reason].label;
}

/** What the card shows for one set-aside item: label, meaning, next step, buttons, extra note. */
export interface PlanQueueParkReasonDisplay {
  label: string;
  meaning: string;
  next: string;
  actions: readonly PlanQueueParkAction[];
  /** Extra line under the label: the recorded reason, or the last finding. */
  extra: string | null;
}

const HISTORICAL_DISPLAY: PlanQueueParkReasonHelp = {
  label: "Couldn't check readiness (old classification step)",
  meaning: 'An older readiness step set this aside and wrote its failure here; the worker itself did not fail.',
  next: 'Resume puts it back in the queue — the queue checks readiness itself now.',
  actions: ['resume', 'discard'],
};

/** Trying again would redo or overwrite finished work, so only the deliberate choices remain. */
const MERGED_SINCE_DISPLAY: PlanQueueParkReasonDisplay = {
  label: 'A newer attempt already merged',
  meaning: 'A newer attempt at this document merged after this one stopped.',
  next: 'Check whether this branch holds anything you still need. Merge without checks adds it on top of the merged work; Discard deletes it.',
  actions: ['merge-without-checks', 'discard'],
  extra: null,
};

export function planQueueDisplayParkReason(
  item: Pick<PlanQueueItemDto, 'parkReason'> & Partial<Pick<PlanQueueItemDto, 'state' | 'detail' | 'round' | 'verdict'>>,
  options: { maxRounds?: number; mergedSince?: boolean } = {},
): PlanQueueParkReasonDisplay | null {
  if (options.mergedSince) return MERGED_SINCE_DISPLAY;
  const reason = item.parkReason;
  if (!reason) return item.state === 'parked' ? {
    label: 'Reason not recorded', meaning: 'This older job was set aside without a recorded reason.',
    next: 'Review its details, then Resume to try again.', actions: ['resume', 'discard'], extra: null,
  } : null;
  const fallback: PlanQueueParkReasonDisplay = {
    label: planQueueParkReasonLabel(reason, { round: item.round, ...options }),
    meaning: PARK_REASON_HELP[reason].meaning,
    next: PARK_REASON_HELP[reason].next,
    actions: PARK_REASON_HELP[reason].actions,
    extra: null,
  };
  if (reason === 'round-limit') {
    const lastFinding = item.verdict?.findings[0]?.summary ?? null;
    return { ...fallback, extra: lastFinding ? `Last finding: ${stripAbsolutePaths(lastFinding)}` : null };
  }
  if (reason === 'no-diverse-verifier') {
    return { ...fallback, extra: item.detail ? stripAbsolutePaths(item.detail.trim()) : null };
  }
  if (reason === 'worker-error' && isHistoricalClassificationDetail(item.detail)) {
    return { ...HISTORICAL_DISPLAY, extra: null };
  }
  if (reason === 'worktree-error' && item.detail?.includes('Could not restore the saved work.')) {
    return { ...fallback, label: 'The saved work could not be restored',
      meaning: 'Harness stopped the sessions but could not safely restore the work folder.',
      next: 'Review the work folder before choosing Resume.' };
  }
  return fallback;
}
