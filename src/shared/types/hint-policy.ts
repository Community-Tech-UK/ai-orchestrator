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
    id: 'loop-config-first-open',
    title: 'A loop runs until it can prove it is done',
    body:
      'It repeats until your verify command passes and the completion gate clears, '
      + 'or until it hits a cap. Caps add one wrap-up turn on top.',
    action: 'Set a verify command if you have one — it is what turns "looks done" into "is done".',
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
