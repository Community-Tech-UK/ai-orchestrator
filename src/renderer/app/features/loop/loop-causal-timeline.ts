/**
 * B5 — loop status as four steps and a reason, instead of a status word.
 *
 * `paused`, `cap-reached`, `provider-limit`, `needs-human-arbitration` are
 * accurate and they do not answer the two questions an operator actually has:
 * what is it stuck on, and what happens next without me. This reduces a loop
 * state to four stable steps — work, verify, independent review, terminal
 * decision — marks which one is blocking, and names the next automatic action
 * and the recovery the operator can take.
 *
 * Four steps, always the same four, in the same order. A timeline whose shape
 * changes with the status is a second status display; the point of fixed steps
 * is that the operator learns the shape once.
 *
 * Pure: takes a state snapshot, returns view data. No IPC, no store, no
 * Electron — so the seeded UI states in the spec are the real reducer output,
 * not a mock of it.
 */

export type LoopTimelineStepId = 'work' | 'verify' | 'review' | 'decision';

export type LoopTimelineStepState =
  /** Finished and moved past. */
  | 'done'
  /** Where the loop is right now. */
  | 'active'
  /** Where it is stuck. */
  | 'blocked'
  /** Not reached yet. */
  | 'pending'
  /** Not part of this run's configuration at all. */
  | 'skipped';

export interface LoopTimelineStep {
  id: LoopTimelineStepId;
  label: string;
  state: LoopTimelineStepState;
  /** Why this step is where it is. Present on the blocking step at minimum. */
  detail?: string;
}

/** What the operator can do about a blocked step. */
export interface LoopRecoveryAction {
  /** Stable id so a host can wire a button without matching on prose. */
  id: 'resume' | 'raise-cap' | 'wait-or-switch-provider' | 'review-now' | 'none';
  label: string;
  /** What pressing it does, in one sentence. */
  description: string;
}

export interface LoopTimelineInput {
  status: string;
  /** `null` while a provider-limit park is resumable; set once it is terminal. */
  endedAt?: number | null;
  pausedForInput?: boolean;
  iteration?: number;
  maxIterations?: number | null;
  /** Whether this run has a verify command configured at all. */
  hasVerifyCommand?: boolean;
  /** Whether independent review is part of this run. */
  hasIndependentReview?: boolean;
  /** Spend so far, in cents. */
  spentCents?: number;
  maxCostCents?: number | null;
  /**
   * True when the spend figure came from the provider rather than being
   * estimated from token counts. Labelled, never blended: an estimate presented
   * as a measurement is how a cost display stops being trusted.
   */
  spendIsProviderReported?: boolean;
}

export interface LoopTimeline {
  steps: LoopTimelineStep[];
  /** The step the run is stuck on, or null when it is simply progressing. */
  blockingStepId: LoopTimelineStepId | null;
  /** What happens next WITHOUT the operator. */
  nextAutomaticAction: string;
  recovery: LoopRecoveryAction;
  /** One sentence for a screen reader; changes only when the state changes. */
  announcement: string;
  spend: LoopSpendMeter;
}

export interface LoopSpendMeter {
  spentCents: number;
  maxCostCents: number | null;
  /** "provider-reported" or "estimated" — stated, not implied. */
  sourceLabel: 'provider-reported' | 'estimated';
  /** 0..1 of the cap, or null when there is no cap to be a fraction of. */
  fractionOfCap: number | null;
}

const TERMINAL_STATUSES = new Set([
  'completed', 'completed-needs-review', 'cancelled', 'failed', 'error',
  'no-progress', 'cap-reached', 'cost-exceeded', 'needs-human-arbitration',
  'reviewer-unreliable', 'reviewer-unavailable', 'builder-unreliable',
]);

const NO_RECOVERY: LoopRecoveryAction = {
  id: 'none',
  label: '',
  description: '',
};

function spendMeter(input: LoopTimelineInput): LoopSpendMeter {
  const spentCents = input.spentCents ?? 0;
  const maxCostCents = input.maxCostCents ?? null;
  return {
    spentCents,
    maxCostCents,
    sourceLabel: input.spendIsProviderReported ? 'provider-reported' : 'estimated',
    fractionOfCap: maxCostCents && maxCostCents > 0
      ? Math.min(1, spentCents / maxCostCents)
      : null,
  };
}

function isProviderLimitParked(input: LoopTimelineInput): boolean {
  return input.status === 'provider-limit' && (input.endedAt ?? null) === null;
}

/** The four steps, with the blocking one marked. */
function buildSteps(
  input: LoopTimelineInput,
  blocking: LoopTimelineStepId | null,
  detail: string,
): LoopTimelineStep[] {
  const terminal = TERMINAL_STATUSES.has(input.status);
  const step = (
    id: LoopTimelineStepId,
    label: string,
    state: LoopTimelineStepState,
  ): LoopTimelineStep => ({
    id,
    label,
    state: id === blocking ? 'blocked' : state,
    ...(id === blocking && detail ? { detail } : {}),
  });

  return [
    step('work', 'Work', terminal ? 'done' : 'active'),
    step(
      'verify',
      'Verify',
      input.hasVerifyCommand === false ? 'skipped' : terminal ? 'done' : 'pending',
    ),
    step(
      'review',
      'Independent review',
      input.hasIndependentReview === false ? 'skipped' : terminal ? 'done' : 'pending',
    ),
    step('decision', 'Terminal decision', terminal ? 'done' : 'pending'),
  ];
}

/**
 * Reduce a loop state to the timeline.
 *
 * The blocked cases are enumerated explicitly rather than derived from a
 * category, because each one has a genuinely different answer to "what happens
 * next without me" — and that sentence is the whole point of the component.
 */
export function buildLoopCausalTimeline(input: LoopTimelineInput): LoopTimeline {
  const spend = spendMeter(input);

  let blocking: LoopTimelineStepId | null = null;
  let detail = '';
  let nextAutomaticAction = '';
  let recovery: LoopRecoveryAction = NO_RECOVERY;

  if (input.status === 'paused' && input.pausedForInput) {
    blocking = 'decision';
    detail = 'The run asked you a question and is waiting for an answer.';
    nextAutomaticAction = 'Nothing. It stays paused until you reply.';
    recovery = {
      id: 'resume',
      label: 'Answer and resume',
      description: 'Send your answer; the run continues from where it paused.',
    };
  } else if (input.status === 'paused') {
    blocking = 'work';
    detail = 'Paused.';
    nextAutomaticAction = 'Nothing. It stays paused until you resume it.';
    recovery = {
      id: 'resume',
      label: 'Resume',
      description: 'Continue the run from where it stopped.',
    };
  } else if (isProviderLimitParked(input)) {
    blocking = 'work';
    detail = 'The provider signalled a usage limit, so the run parked instead of paying overage.';
    nextAutomaticAction = 'It resumes on its own once the provider window reopens.';
    recovery = {
      id: 'wait-or-switch-provider',
      label: 'Switch provider',
      description: 'Wait for the window to reopen, or move the run to another provider.',
    };
  } else if (input.status === 'cap-reached' || input.status === 'cost-exceeded') {
    blocking = 'decision';
    detail = input.status === 'cost-exceeded'
      ? 'The run hit its cost cap before converging.'
      : 'The run hit its iteration cap before converging.';
    nextAutomaticAction = 'Nothing. The run has stopped.';
    recovery = {
      id: 'raise-cap',
      label: 'Raise the cap and continue',
      description: 'Give it more room and restart from where it stopped.',
    };
  } else if (input.status === 'needs-human-arbitration') {
    blocking = 'review';
    detail = 'The builder and the reviewer disagree and cannot settle it between them.';
    nextAutomaticAction = 'Nothing. It needs your decision.';
    recovery = {
      id: 'review-now',
      label: 'Review the disagreement',
      description: 'Read both positions and decide which one stands.',
    };
  } else if (input.status === 'completed-needs-review') {
    blocking = 'review';
    detail = 'The work is done and accepted, but it is asking for a human glance.';
    nextAutomaticAction = 'Nothing. It finished; this is a request, not a failure.';
    recovery = {
      id: 'review-now',
      label: 'Take a look',
      description: 'Read what it produced and close the run out.',
    };
  } else if (TERMINAL_STATUSES.has(input.status)) {
    nextAutomaticAction = 'Nothing. The run has finished.';
  } else if (input.status === 'running') {
    const at = input.iteration;
    const cap = input.maxIterations ?? null;
    nextAutomaticAction = at !== undefined && cap !== null
      ? `It continues to iteration ${at + 1} of ${cap}.`
      : 'It continues to the next iteration.';
  } else {
    nextAutomaticAction = 'It continues.';
  }

  const steps = buildSteps(input, blocking, detail);
  const blocked = steps.find((s) => s.state === 'blocked');

  return {
    steps,
    blockingStepId: blocking,
    nextAutomaticAction,
    recovery,
    // One sentence, and only about the state — so a host can announce it once
    // per change without reading the whole timeline aloud on every tick.
    announcement: blocked
      ? `Blocked at ${blocked.label}. ${detail} ${nextAutomaticAction}`.trim()
      : `${input.status}. ${nextAutomaticAction}`.trim(),
    spend,
  };
}
