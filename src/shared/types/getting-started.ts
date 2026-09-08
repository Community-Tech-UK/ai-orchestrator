/**
 * UX5 — the getting-started bar, as a pure reducer.
 *
 * The item's own spec: "pending-first, N/M counter, unmounts when done", ahead
 * of any paged tour. So this is a checklist that disappears rather than a tour
 * that has to be sat through — someone who already has a CLI installed and a
 * session running never sees it at all.
 *
 * **Every step is derived from state the app already has.** That constraint is
 * the whole design: a getting-started bar whose steps are guesses would tell a
 * working installation it is not set up, which is the fastest way to make the
 * whole surface ignorable. Nothing here introduces a new signal, and steps that
 * could not be measured honestly were not invented.
 */

export type GettingStartedStepId =
  /** At least one provider CLI is usable. */
  | 'provider-available'
  /** A default working directory is set, so new sessions have somewhere to go. */
  | 'working-directory'
  /** At least one session has EVER been started on this device. */
  | 'first-session';

export interface GettingStartedStep {
  id: GettingStartedStepId;
  label: string;
  /** What doing it gets you, in the operator's terms. */
  detail: string;
  done: boolean;
}

export interface GettingStartedInput {
  /**
   * Status of the startup report's aggregate `provider.any` check, or `null`
   * when the report has not arrived yet.
   *
   * **This must be the aggregate, not the individual provider checks.** A first
   * version read every `provider`-category check and treated `ready` OR
   * `degraded` as usable, on the assumption that `degraded` meant "installed
   * with a caveat". It does not: `capability-probe.ts` assigns `degraded` to a
   * provider that is **not on PATH at all**, and it probes a fixed list of five
   * providers unconditionally — so every install, including one with no CLI
   * whatsoever, always produced at least one `degraded` check and the step was
   * permanently "done". `provider.any` is the app's own answer to exactly this
   * question: `ready` iff some provider check is genuinely `ready`.
   */
  providerAnyStatus: string | null;
  defaultWorkingDirectory: string;
  /**
   * Has a session ever been started on this device?
   *
   * NOT a live instance count. This was `instanceCount > 0` first, and closing
   * the only open session dropped it back to zero — bringing the whole bar
   * back to tell a user to do the thing they had just done. A step that can
   * un-complete breaks the bar's one promise, that finishing is the dismissal.
   */
  hasEverStartedSession: boolean;
}

export interface GettingStartedState {
  /** Pending first, then done — the spec's ordering. */
  steps: GettingStartedStep[];
  completed: number;
  total: number;
  /** True when the bar should render at all. */
  visible: boolean;
}

function buildSteps(input: GettingStartedInput): GettingStartedStep[] {
  return [
    {
      id: 'provider-available',
      label: 'Connect a CLI',
      // Names only CLIs the probe actually looks for, and says "ready" rather
      // than "on your PATH". Of the five probed providers, THREE — Claude Code,
      // Codex and Copilot — also get an `authenticated` probe
      // (`provider-doctor.ts` `appliesTo`), and any failing probe downgrades the
      // provider to `degraded`; only Antigravity and Cursor need nothing but the
      // binary. Promising that PATH is the whole requirement would leave a
      // signed-out user stuck on a step whose own text said they had met it.
      detail: 'AI Orchestrator drives coding CLIs like Claude Code and Codex — it needs at least one installed and ready to use (signed in, where that applies).',
      done: input.providerAnyStatus === 'ready',
    },
    {
      id: 'working-directory',
      label: 'Pick a default working directory',
      detail: 'New sessions start here, so you are not choosing a folder every time.',
      done: input.defaultWorkingDirectory.trim() !== '',
    },
    {
      id: 'first-session',
      label: 'Start a session',
      detail: 'Everything else — loops, review, cost tracking — hangs off a running session.',
      done: input.hasEverStartedSession,
    },
  ];
}

/**
 * Reduce the app's real state to the bar.
 *
 * `visible` is false once every step is done: the spec asks for a surface that
 * unmounts rather than one more thing to dismiss. It is also false when the
 * startup report has not arrived yet (no provider statuses at all) — showing
 * "0 of 3" for a fully-configured install during the first second after launch
 * would be a confident wrong answer, and this bar's credibility is the only
 * thing making it worth showing.
 */
export function buildGettingStarted(input: GettingStartedInput): GettingStartedState {
  const steps = buildSteps(input);
  const completed = steps.filter((step) => step.done).length;
  const reportArrived = input.providerAnyStatus !== null;

  return {
    // Pending first. Stable within each group so the list does not reshuffle
    // as unrelated state changes.
    steps: [...steps.filter((s) => !s.done), ...steps.filter((s) => s.done)],
    completed,
    total: steps.length,
    visible: reportArrived && completed < steps.length,
  };
}

/** "1 of 3 done" — the counter the spec asks for. */
export function gettingStartedCounter(state: GettingStartedState): string {
  return `${state.completed} of ${state.total} done`;
}
