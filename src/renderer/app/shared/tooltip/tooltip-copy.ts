/**
 * UX1 — the central tooltip copy registry.
 *
 * Plain TypeScript, deliberately not an i18n framework: the point is one place
 * to read and review every hint the app shows, so the wording can be checked
 * for honesty in one sitting rather than hunted across sixty templates. It is
 * also the seed for a key-typed copy dictionary later (U14) if that ever earns
 * its place.
 *
 * House rules from the plan, applied to every entry here:
 *
 * 1. Shape is `{ label, meaning, consequence? }`. If a user needs the
 *    `consequence` to make the decision, it does NOT belong in a hover tooltip
 *    — use an inline hint instead.
 * 2. **Never hide a destructive consequence in a tooltip.** Anything that
 *    deletes, terminates, or spends money says so inline, next to the control.
 *
 *    Two things this rule does NOT mean, both learned the hard way:
 *
 *    - It does not mean "remove the hover". During UX3 it was read that way and
 *      the Terminate button lost its `title` for an `aria-label` alone, leaving
 *      sighted mouse users a bare `×` on an unconfirmed session-ending action
 *      while every sibling icon kept a hint. An `aria-label` is not "inline" —
 *      it is invisible to everyone not using a screen reader. Deleting a
 *      disclosure is never how you comply with a disclosure rule.
 *    - It is not satisfied by adding the hover back either. **Terminate does
 *      not currently meet this rule.** Its consequence lives in `appTooltip` +
 *      `aria-label`, which are hover-only and AT-only; there is no persistently
 *      visible warning and no confirmation step
 *      (`instance-row.component.ts` `onTerminate` → `instance-list.component.ts`
 *      `onTerminateInstance` → `store.terminateInstance`, no confirm anywhere).
 *      Closing it properly means an inline caption or a confirm dialog — a UX
 *      change beyond the tooltip rollout, so it is recorded as an open decision
 *      in the backlog plan rather than papered over by softening this rule.
 * 4. **A tooltip may elaborate; it may not be the only carrier.** If a tooltip
 *    says something the element's visible text does not — a state, not just an
 *    explanation of the state — then a mouse-only hover is the only way to learn
 *    it, and keyboard and screen-reader users never do. Either put it in the
 *    visible text or make the host focusable so the tooltip opens on focus.
 *
 *    The test is NOT "does the element have visible text" — that was tried and
 *    it missed the remote-node badge, whose text is the node name in BOTH the
 *    healthy and disconnected states, with the difference carried by an amber
 *    class and a hover string. The test is whether the visible text conveys what
 *    the tooltip conveys. `icon-control-tooltip.spec.ts` pins the set of hosts
 *    exempted from this so a new one cannot be added silently.
 *
 *    Note the wider class this sits inside: **state carried by colour alone**.
 *    A tooltip is one way that happens; a CSS class driven by a data attribute
 *    with no tooltip at all is another, and no tooltip guard can see it.
 *
 * 3. Say what the control DOES, not what it is called. "Resume anyway" already
 *    tells you the name; the tooltip's job is "the loop paused for a reason —
 *    this ignores it".
 */

export interface TooltipCopyEntry {
  /** The control's own name, for reference in reviews. */
  label: string;
  /** What the control does, in one sentence. This is the tooltip body. */
  meaning: string;
  /**
   * What happens as a result, when it is not obvious and not destructive.
   * Destructive consequences belong inline — see house rule 2.
   */
  consequence?: string;
}

/** Render an entry as the string a tooltip shows. */
export function tooltipText(entry: TooltipCopyEntry): string {
  return entry.consequence ? `${entry.meaning} ${entry.consequence}` : entry.meaning;
}

/**
 * The registry. Keys are stable ids referenced from templates, so renaming a
 * control does not silently orphan its copy.
 */
export const TOOLTIP_COPY = {
  // ---- Loop HUD controls (UX3 rollout order: loop HUD first) ----
  'loop.pause': {
    label: 'Pause',
    meaning: 'Stops the loop after the current iteration finishes.',
    consequence: 'Work already done is kept.',
  },
  'loop.resume': {
    label: 'Resume',
    meaning: 'Continues a paused loop from where it stopped.',
  },
  'loop.resumeAnyway': {
    label: 'Resume anyway',
    meaning: 'Continues even though the loop paused because it was not making progress.',
    consequence: 'Nothing about the situation has changed, so it may stall again.',
  },
  'loop.hint': {
    label: 'Hint',
    meaning: 'Sends a direction the agent reads at the start of its NEXT iteration.',
    consequence: 'It does not interrupt the turn that is running.',
  },
  'loop.followUp': {
    label: 'Follow-up',
    meaning: 'Queues a message the loop must handle before it is allowed to finish.',
  },
  'loop.inspect': {
    label: 'Inspect',
    meaning: 'Opens the iteration-by-iteration trace of what the loop did.',
  },
  'loop.statusPill': {
    label: 'Status',
    meaning: 'The loop run’s current state.',
  },
  'loop.acceptCompletion': {
    label: 'Accept as complete',
    meaning: 'Signs off the work yourself and ends the run as complete.',
  },

  // ---- Loop metric strip (dense variant) ----
  'loop.iterations': {
    label: 'Iterations',
    meaning: 'Iterations run so far, against the cap for this run.',
    consequence: 'An iteration or wall-time cap adds one wrap-up turn on top.',
  },
  'loop.tokens': {
    label: 'Tokens',
    meaning: 'Tokens this run has spent, as reported by the provider.',
    consequence: 'The current turn is not counted until it settles.',
  },
  'loop.cost': {
    label: 'Cost',
    meaning: 'Estimated spend for this run.',
    consequence: 'An estimate from token counts, not a bill.',
  },
  'loop.phase': {
    label: 'Phase',
    meaning: 'What the agent appears to be doing right now, inferred from its commands.',
    consequence: 'Advisory — nothing stops or continues because of it.',
  },

  // ---- Honesty chips ----
  'loop.chip.unstick': {
    label: 'Unstick',
    meaning: 'The loop noticed it was not progressing and nudged the agent to change approach.',
    consequence: 'After two attempts it stops nudging.',
  },
  'loop.chip.wrapUp': {
    label: 'Wrap-up',
    meaning: 'The run hit a cap and is spending one final turn writing its hand-off notes.',
  },
  'loop.chip.parked': {
    label: 'Parked',
    meaning: 'Items the loop could not finish and set aside with a reason.',
    consequence: 'The work is kept, not dropped.',
  },
  // L6 named non-convergence reasons. Each says what to DO about it, because
  // "the loop is stuck" is the part the operator can already see.
  'loop.chip.reviewNotConverging': {
    label: 'Review not converging',
    meaning: 'The reviewer keeps raising the same unresolved finding round after round.',
    consequence: 'Either the finding is wrong and should be dismissed, or it needs a decision the agent cannot make.',
  },
  'loop.chip.landableUncommitted': {
    label: 'Landable · uncommitted',
    meaning: 'Verify passes and the work is changed but not committed.',
    consequence: 'Review and commit it rather than asking for more iterations.',
  },
  'loop.chip.scopeWidened': {
    label: 'Scope widened',
    meaning: 'The change is touching more files each iteration instead of converging.',
    consequence: 'Re-state the goal narrowly, or split the remaining work.',
  },
  'loop.chip.noProgress': {
    label: 'No progress',
    meaning: 'No observable movement, and no more specific cause was found.',
  },
  'loop.chip.reviewPingPong': {
    label: 'Review ping-pong',
    meaning: 'A second model is reviewing each completion claim until it agrees.',
  },

  // ---- Loop configuration honesty (T1/T3/T11) ----
  'loop.recycleToggle': {
    label: 'Recycle context on long runs',
    meaning: 'Starts a fresh model window mid-run when the current one fills up.',
    consequence: 'Only providers that report their live window can do this.',
  },
  'loop.isolation': {
    label: 'Work in an isolated copy',
    meaning: 'The agent edits a separate worktree instead of your checkout.',
  },
  'loop.verifyTwice': {
    label: 'Run verify twice',
    meaning: 'Re-runs the verify command to catch a flaky result.',
    consequence: 'Doubles how long a completion check takes.',
  },
} as const satisfies Record<string, TooltipCopyEntry>;

export type TooltipCopyKey = keyof typeof TOOLTIP_COPY;

/** Look up a registry entry's tooltip string. */
export function copyFor(key: TooltipCopyKey): string {
  return tooltipText(TOOLTIP_COPY[key]);
}
