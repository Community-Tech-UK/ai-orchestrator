/**
 * UX5 — behaviour-gated hints.
 *
 * The rule that makes a hint tolerable is that it is EARNED: it appears because
 * you did something that makes it relevant, it can be dismissed, and it never
 * comes back. A tip that shows on every visit is an advert, and users learn to
 * look past the region it occupies — which then costs you the one time it
 * mattered.
 *
 * Pure and shared so the decision is testable without a renderer, and so the
 * copy lives in one reviewable place (the same reason `TOOLTIP_COPY` exists).
 */

export type HintId =
  /** First time the loop configuration is opened. */
  | 'loop-config-first-open'
  /** A run parked on a provider limit while self-resume is switched off. */
  | 'loop-provider-limit-resume-off'
  /** A critical tool loop is live and auto-interrupt is off. */
  | 'tool-loop-auto-interrupt-off'
  /** A message was queued for an instance that is running a loop. */
  | 'queued-while-looping'
  /** Several sessions are running with the cost display switched off. */
  | 'cost-hidden-while-busy'
  /** Settings overview, once the user has more than a couple of instances. */
  | 'settings-overview-profiles';

export interface HintCopy {
  id: HintId;
  title: string;
  body: string;
  /** What the reader should do, if anything. Omitted when the hint is purely informational. */
  action?: string;
}

export const HINTS: Readonly<Record<HintId, HintCopy>> = {
  'loop-config-first-open': {
    // Both halves of this sentence were wrong at some point, each caught by a
    // separate gate — worth recording, because the pattern was the same twice:
    // compressing a conditional rule into a flat one.
    //
    // The completion half originally said a loop "repeats until your verify
    // command passes and the completion gate clears", full stop. False for
    // operator-reviewed completion, a checkbox on this very panel, where the
    // run pauses for sign-off and ends when a human clicks Accept as complete —
    // neither verify nor the gate involved.
    //
    // The cap half says nothing about wrap-up turns, deliberately, after two
    // wrong drafts.
    //
    // "It repeats until the work is accepted" also read as though acceptance
    // were the only ending, which it is not — `failed`, `error`, `no-progress`,
    // `needs-human-arbitration` and the rest are all terminal. Rather than
    // enumerate them (the move that produced every earlier error here), the
    // sentence now makes the weaker claim that it can stop before acceptance.
    // A weaker claim cannot be false.
    // "Caps add one wrap-up turn" was false for token/cost caps; "an iteration
    // or wall-time cap adds one wrap-up turn" was still false, because
    // `loop-pre-iteration-guard.ts` also requires `capWrapUpIteration` and a
    // provider that enforces the wrap-up tools-disable — today only `claude`,
    // one of seven providers. A first-open hint cannot state that rule in a
    // sentence, and stating a simpler version of it is how both drafts went
    // wrong. What is unconditionally true is that a cap ends the run.
    id: 'loop-config-first-open',
    title: 'A loop runs until it can prove it is done',
    body:
      'It repeats until the work is accepted — automatically once your verify '
      + 'command passes and the completion gate clears, or by you if you turn on '
      + 'operator-reviewed completion. It can also stop before then: a cap ends '
      + 'the run whether or not it got there, and so does a failure it cannot get past.',
    action: 'Set a verify command if you have one — it is what turns "looks done" into "is done".',
  },
  'loop-provider-limit-resume-off': {
    id: 'loop-provider-limit-resume-off',
    title: 'This run is parked until the provider window reopens',
    body:
      'Provider-limit recovery is off, so it will sit here rather than resume itself '
      + 'when the window clears — which overnight means the run is simply dead until morning.',
    action: 'Turn on provider-limit recovery in Settings, or switch this run to another provider.',
  },
  'tool-loop-auto-interrupt-off': {
    // "A tool call is repeating with no progress" described only ONE of the
    // detector's three kinds (`doom-loop-detector.ts`): `repeat-no-progress`,
    // `ping-pong` (alternating A/B/A/B) and `runaway` (a burst in one turn) all
    // escalate to critical independently, and this hint fires for any of them.
    id: 'tool-loop-auto-interrupt-off',
    title: 'Nothing will stop this loop but you',
    body:
      'An agent is stuck in a tool loop, and auto-interrupt is off, so it keeps '
      + 'spending until someone intervenes.',
    action: 'Turn on auto-interrupt to stop this class of loop by itself next time.',
  },
  'queued-while-looping': {
    id: 'queued-while-looping',
    title: 'Queued messages wait for the loop, not the turn',
    body:
      'A loop drives its own iterations, so a queued message goes in when the loop next '
      + 'asks for input — not at the end of the current turn.',
    action: 'Use Steer if you need the running iteration to change course now.',
  },
  'cost-hidden-while-busy': {
    // Scoped to what `showCost` actually gates TODAY, which took two
    // corrections to get right. The first draft said spend was hidden
    // "anywhere in the app" — false; the Costs & Usage page renders per-session
    // cost and never reads the setting. The second said "the sidebar total or
    // the per-session views" — also false: `context-bar` reads `showCost`, but
    // its only mount (`instance-header.component.html`) hardcodes
    // `[showCost]="false"`, and `token-counter` is unmounted anywhere in the
    // app. So the sidebar total is the one visible thing this toggle changes.
    // Naming more than that would mislead the managed-deployment operator the
    // setting's own doc comment ("Off = hide for managed setups") is aimed at.
    id: 'cost-hidden-while-busy',
    title: 'Several sessions are running with cost hidden',
    body:
      'Cost display is off, so the sidebar total is not showing what these '
      + 'sessions are spending while they work.',
    action: 'The Costs & Usage page still shows it, or turn the display back on in Settings.',
  },
  'settings-overview-profiles': {
    id: 'settings-overview-profiles',
    title: 'Unattended runs want different settings',
    body:
      'The Overnight profile turns on provider-limit recovery and tool-loop interruption, '
      + 'and warns earlier about context.',
    action: 'Switch profiles on the General tab; it changes nothing until you do.',
  },
};

export interface HintDecision {
  show: boolean;
  /** Why not, when `show` is false. Useful in tests and diagnostics. */
  reason?: 'dismissed' | 'condition-not-met' | 'unknown-hint';
}

export interface HintDecisionInput {
  id: HintId;
  /** Hint ids the user has dismissed. */
  dismissed: readonly string[];
  /**
   * The behaviour that earns this hint. `false` means "not yet relevant" — the
   * hint is not shown and is NOT marked seen, so it can still appear later.
   */
  condition: boolean;
}

export function shouldShowHint(input: HintDecisionInput): HintDecision {
  if (!(input.id in HINTS)) return { show: false, reason: 'unknown-hint' };
  if (input.dismissed.includes(input.id)) return { show: false, reason: 'dismissed' };
  if (!input.condition) return { show: false, reason: 'condition-not-met' };
  return { show: true };
}

/**
 * Add a dismissal without duplicating it.
 *
 * Returns the same array reference when nothing changed, so a caller can skip a
 * pointless settings write — dismissing twice should not cost a round trip.
 */
export function withDismissed(dismissed: readonly string[], id: HintId): readonly string[] {
  return dismissed.includes(id) ? dismissed : [...dismissed, id];
}

/**
 * UX5 predicates — the "earned" half of a behaviour-gated hint.
 *
 * Kept beside the copy they gate so the condition and the sentence it triggers
 * are read together. A hint whose predicate drifts away from its wording is how
 * you end up advising someone about a situation they are not in.
 */

/**
 * Queuing while a loop runs is the case where the composer's usual promise —
 * "sends at the end of this turn" — is wrong: a loop drives its own iterations,
 * so the message waits for the loop to ask for input. Silent on an ordinary
 * queued message, where the normal mental model is correct.
 */
export function shouldHintQueuedWhileLooping(queuedCount: number, isLooping: boolean): boolean {
  return queuedCount > 0 && isLooping;
}

/**
 * A run parked on a provider limit with self-resume switched off will sit there
 * until a person notices. The same run with recovery on needs no advice, and a
 * run that has already ended is past helping.
 */
export function shouldHintProviderLimitResumeOff(
  status: string,
  endedAt: number | null,
  resumeEnabled: boolean,
): boolean {
  return status === 'provider-limit' && endedAt === null && !resumeEnabled;
}

/** A tool loop is live and nothing but the operator will stop it. */
export function shouldHintToolLoopAutoInterruptOff(
  hasCriticalAlert: boolean,
  autoInterruptEnabled: boolean,
): boolean {
  return hasCriticalAlert && !autoInterruptEnabled;
}

/**
 * How many concurrently-busy sessions make a hidden cost display worth
 * mentioning. One or two is an ordinary session someone is watching; several at
 * once is the case where spend accumulates out of sight.
 */
export const COST_HIDDEN_BUSY_THRESHOLD = 3;

/**
 * Cost display is off while several sessions are actively working.
 *
 * `showCost` defaults to ON, so this only fires for someone who deliberately
 * turned it off — the hint tells them what that now costs them in visibility,
 * rather than second-guessing the setting.
 */
export function shouldHintCostHiddenWhileBusy(
  busyInstanceCount: number,
  showCost: boolean,
): boolean {
  return !showCost && busyInstanceCount >= COST_HIDDEN_BUSY_THRESHOLD;
}
