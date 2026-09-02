/**
 * Operator-facing diagnosis for loop WARN/CRITICAL.
 *
 * Detectors already emit a human `message`. This catalog adds the three
 * answers the HUD was missing: what happened, whether it is fixable, and
 * what to do next. Pure: same input → same output.
 */
import type { LoopIterationPayload } from '@contracts/schemas/loop';

export type LoopIssueSeverity = 'WARN' | 'CRITICAL';
export type LoopIssueFixability = 'fixable' | 'maybe' | 'not-by-hint';
export type LoopIssueActionKind = 'hint' | 'inspect' | 'stop' | 'resume';

export interface ProgressSignalCatalogEntry {
  title: string;
  meaning: string;
  fixability: LoopIssueFixability;
  nextStep: string;
}

export const PROGRESS_SIGNAL_CATALOG: Record<string, ProgressSignalCatalogEntry> = {
  A: {
    title: 'Repeating the same work',
    meaning: 'The agent did the same file edits and tools as a previous iteration — no new work signature.',
    fixability: 'fixable',
    nextStep: 'Give a hint that names a different approach, file, or next concrete step.',
  },
  B: {
    title: 'Flipping the same files back and forth',
    meaning: 'A file was edited to A, then B, then back to A. That is churn, not progress.',
    fixability: 'fixable',
    nextStep: 'Hint which version to keep, or tell it to stop reverting that file.',
  },
  C: {
    title: 'Stuck on one stage too long',
    meaning: 'The loop has spent many iterations on the current stage without finishing it.',
    fixability: 'maybe',
    nextStep: 'If the work is actually progressing, let it continue. Otherwise hint a narrower goal.',
  },
  D: {
    title: 'Tests flipping pass/fail',
    meaning: 'The test pass count is oscillating instead of steadily improving.',
    fixability: 'fixable',
    nextStep: 'Hint the real failing test, or tell it to stop chasing a flaky count.',
  },
  'D-prime': {
    title: 'Editing files but tests are not moving',
    meaning: 'Files keep changing while the test pass count stays the same.',
    fixability: 'fixable',
    nextStep: 'Hint which tests should change, or whether it should run them at all.',
  },
  E: {
    title: 'Same error keeps coming back',
    meaning: 'The same error bucket or exact error appeared across several iterations.',
    fixability: 'fixable',
    nextStep: 'Hint the actual fix, a workaround, or tell it to skip that failing path.',
  },
  F: {
    title: 'Spending tokens without test progress',
    meaning: 'A lot of tokens have been used since the last test improvement.',
    fixability: 'not-by-hint',
    nextStep: 'Decide whether the spend is worth it. Stop if this is waste; otherwise change the goal.',
  },
  G: {
    title: 'Repeating the same tool calls',
    meaning: 'The same tool was called over and over with the same arguments, or the same tool set repeated across iterations.',
    fixability: 'fixable',
    nextStep: 'Hint a different next action — a file to edit, a command to skip, or a new approach.',
  },
  H: {
    title: 'Saying the same thing each iteration',
    meaning: 'The last few iteration write-ups are nearly identical, so the agent is restating rather than advancing.',
    fixability: 'maybe',
    nextStep: 'A hint that names the remaining gap usually works. If it already looks done, inspect and accept.',
  },
  I: {
    title: 'Re-reading the same files',
    meaning: 'A read-only tool keeps returning the same result with no edits in between.',
    fixability: 'fixable',
    nextStep: 'Hint what to change next, or tell it to stop re-reading and edit.',
  },
  BLOCKED: {
    title: 'The agent wrote a blocker',
    meaning: 'The loop hit a BLOCKED.md or an explicit block intent and cannot continue on its own.',
    fixability: 'not-by-hint',
    nextStep: 'Read the blocker, resolve the missing access or decision, then hint or resume.',
  },
};

const FALLBACK_CATALOG: ProgressSignalCatalogEntry = {
  title: 'Progress looks unhealthy',
  meaning: 'The loop flagged a progress problem it does not have a named explanation for.',
  fixability: 'maybe',
  nextStep: 'Inspect the iteration evidence, then hint, resume, or stop.',
};

const COMPLETION_SIGNAL_LABELS: Record<string, string> = {
  'completed-rename': 'Completed-file rename',
  'done-promise': 'Done promise',
  'done-sentinel': 'DONE.txt sentinel',
  'all-green': 'All tests green',
  'self-declared': 'Agent said it was done',
  'plan-checklist': 'Plan checklist',
  'declared-complete': 'Declared complete',
  'ledger-complete': 'Task ledger',
};

export interface LoopIssueSignalView {
  id: string;
  title: string;
  verdict: LoopIssueSeverity | 'OK';
  verdictLabel: string;
  message: string;
  meaning: string;
}

export interface LoopIssueAction {
  kind: LoopIssueActionKind;
  label: string;
  primary: boolean;
}

export interface LoopIssueView {
  severity: LoopIssueSeverity;
  chipLabel: string;
  chipTitle: string;
  headline: string;
  problem: string;
  implication: string;
  fixability: LoopIssueFixability;
  fixabilityLabel: string;
  nextStep: string;
  actions: LoopIssueAction[];
  signals: LoopIssueSignalView[];
}

export interface IterationEvidenceView {
  signals: LoopIssueSignalView[];
  completionText: string;
  verifyText: string;
  testsText: string;
  filesText: string;
}

export function catalogForSignal(id: string): ProgressSignalCatalogEntry {
  return PROGRESS_SIGNAL_CATALOG[id] ?? FALLBACK_CATALOG;
}

/** Compact chip / header word. Colour still comes from the raw verdict. */
export function progressVerdictWord(verdict: string): string {
  switch (verdict) {
    case 'CRITICAL': return 'STUCK';
    case 'WARN': return 'WATCH';
    case 'OK': return 'OK';
    default: return verdict;
  }
}

export function progressVerdictHeaderWord(verdict: string): string {
  return progressVerdictWord(verdict).toLowerCase();
}

export function progressVerdictView(
  verdict: string,
  hasRunningIteration: boolean,
  headline?: string,
): { label: string; title: string; value: string } {
  const word = progressVerdictWord(verdict);
  const label = hasRunningIteration ? `LAST ITER · ${word}` : word;
  const title = headline
    ? (hasRunningIteration ? `Last iteration: ${headline}` : headline)
    : hasRunningIteration
      ? 'Last completed iteration progress verdict'
      : 'Latest progress verdict';
  return { label, title, value: verdict };
}

const VERDICT_RANK: Record<string, number> = { CRITICAL: 2, WARN: 1, OK: 0 };

function isIssueSeverity(value: string): value is LoopIssueSeverity {
  return value === 'WARN' || value === 'CRITICAL';
}

function rank(verdict: string): number {
  return VERDICT_RANK[verdict] ?? 0;
}

function fixabilityLabel(fixability: LoopIssueFixability): string {
  switch (fixability) {
    case 'fixable': return 'Usually fixable';
    case 'maybe': return 'Sometimes fixable';
    case 'not-by-hint': return 'Needs a decision';
  }
}

function rollupFixability(signals: LoopIssueSignalView[]): LoopIssueFixability {
  const entries = signals.map((signal) => catalogForSignal(signal.id));
  if (signals.some((signal) => signal.verdict === 'CRITICAL' && catalogForSignal(signal.id).fixability === 'not-by-hint')) {
    return 'not-by-hint';
  }
  if (entries.some((entry) => entry.fixability === 'fixable')) return 'fixable';
  if (entries.some((entry) => entry.fixability === 'not-by-hint')) return 'not-by-hint';
  return 'maybe';
}

/**
 * Worst severity first, detector order preserved within a severity.
 *
 * The detector emits signals in fixed id order (A→I) regardless of verdict,
 * and the WARN-escalation branch appends its CRITICAL `A` to the end of an
 * otherwise all-WARN array. So the raw array's first entry is routinely not
 * the worst one, and headline / problem / next step must all be taken from
 * the same signal or the card contradicts itself.
 */
function bySeverity(signals: LoopIssueSignalView[]): LoopIssueSignalView[] {
  return [...signals].sort((a, b) => rank(b.verdict) - rank(a.verdict));
}

function headlineFor(worst: readonly LoopIssueSignalView[]): string {
  if (worst.length === 0) return 'Last iteration looked unhealthy';
  const top = worst.filter((signal) => signal.verdict === worst[0].verdict);
  const titles = top.map((signal, index) => (
    index === 0 ? signal.title : signal.title.charAt(0).toLowerCase() + signal.title.slice(1)
  ));
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  // Keep the headline to one readable line, but never silently drop a signal —
  // the full list is always in the evidence disclosure.
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

function implicationFor(
  severity: LoopIssueSeverity,
  running: boolean,
  paused: boolean,
  blocked: boolean,
): string {
  if (blocked) {
    return 'The loop cannot continue on its own. It is waiting on you.';
  }
  if (paused) {
    return 'The loop paused because it could not prove progress. It will not continue until you hint, resume, or stop.';
  }
  if (running && severity === 'CRITICAL') {
    return 'The loop is still running. If this keeps happening it will pause on its own. A hint now often unsticks it.';
  }
  if (running && severity === 'WARN') {
    return 'The loop is still running. This is a watch, not a stop. Intervene only if you already know a better path.';
  }
  return 'This iteration did not look healthy. Check the evidence before deciding whether to continue.';
}

function actionsFor(
  severity: LoopIssueSeverity,
  fixability: LoopIssueFixability,
  running: boolean,
  paused: boolean,
  blocked: boolean,
): LoopIssueAction[] {
  const hintPrimary = !blocked && fixability !== 'not-by-hint' && (severity === 'CRITICAL' || paused);
  const actions: LoopIssueAction[] = [
    { kind: 'hint', label: 'Give a hint', primary: hintPrimary },
    { kind: 'inspect', label: 'See why', primary: blocked || (!hintPrimary && !paused) },
  ];
  if (paused) {
    actions.push({ kind: 'resume', label: 'Resume anyway', primary: false });
  }
  if (severity === 'CRITICAL' || blocked) {
    actions.push({ kind: 'stop', label: 'Stop', primary: fixability === 'not-by-hint' && !blocked });
  }
  if (running && severity === 'WARN') {
    return actions.filter((action) => action.kind !== 'stop');
  }
  return actions;
}

export function signalViews(
  signals: readonly { id: string; verdict: string; message: string }[],
): LoopIssueSignalView[] {
  return signals.map((signal) => {
    const entry = catalogForSignal(signal.id);
    return {
      id: signal.id,
      title: entry.title,
      verdict: isIssueSeverity(signal.verdict) ? signal.verdict : 'OK',
      verdictLabel: progressVerdictWord(signal.verdict),
      message: signal.message,
      meaning: entry.meaning,
    };
  });
}

export function buildLoopIssueView(input: {
  verdict: string;
  signals: readonly { id: string; verdict: string; message: string }[];
  /**
   * The signal that actually caused the pause, when the loop is showing a
   * pause banner. A BLOCKED / resource-governor / preflight pause is raised
   * out of band and is never written into the iteration's own
   * `progressSignals`, so without this the diagnosis would lead with a stale
   * per-iteration WARN and drop the real reason entirely.
   */
  pauseSignal?: { id: string; verdict: string; message: string };
  running: boolean;
  paused: boolean;
  blocked?: boolean;
}): LoopIssueView | null {
  const pauseSignal = input.pauseSignal ? signalViews([input.pauseSignal])[0] : null;
  const severity = [input.verdict, pauseSignal?.verdict ?? 'OK']
    .reduce((worst, candidate) => (rank(candidate) > rank(worst) ? candidate : worst), 'OK');
  if (!isIssueSeverity(severity)) return null;

  const iterationSignals = signalViews(input.signals);
  // The pause cause leads; the iteration's own signals stay as supporting
  // evidence. For an ordinary no-progress pause the banner signal *is* one of
  // them, so drop the duplicate rather than showing it twice.
  const signals = pauseSignal
    ? [
      pauseSignal,
      ...iterationSignals.filter(
        (signal) => !(signal.id === pauseSignal.id && signal.message === pauseSignal.message),
      ),
    ]
    : iterationSignals;

  const worstSignals = bySeverity(signals.filter((signal) => isIssueSeverity(signal.verdict)));
  const headline = headlineFor(worstSignals);
  const fixability = rollupFixability(worstSignals.length > 0 ? worstSignals : signals);
  const blocked = input.blocked === true;
  const problem = worstSignals[0]?.message
    ?? signals[0]?.message
    ?? catalogForSignal(input.signals[0]?.id ?? '').meaning;
  return {
    severity,
    chipLabel: progressVerdictWord(severity),
    chipTitle: input.running ? `Last iteration: ${headline}` : headline,
    headline,
    problem,
    implication: implicationFor(severity, input.running, input.paused, blocked),
    fixability,
    fixabilityLabel: fixabilityLabel(fixability),
    nextStep: blocked
      ? catalogForSignal('BLOCKED').nextStep
      : (worstSignals[0] ? catalogForSignal(worstSignals[0].id).nextStep : FALLBACK_CATALOG.nextStep),
    actions: actionsFor(severity, fixability, input.running, input.paused, blocked),
    signals: worstSignals.length > 0 ? worstSignals : signals,
  };
}

function completionLabel(id: string): string {
  return COMPLETION_SIGNAL_LABELS[id] ?? id;
}

export function buildIterationEvidenceView(iteration: {
  progressSignals: readonly { id: string; verdict: string; message: string }[];
  completionSignalsFired: readonly { id: string; sufficient: boolean }[];
  verifyStatus: string;
  verifyFailureKind?: string;
  testPassCount: number | null;
  testFailCount: number | null;
  filesChanged: readonly { path: string; additions: number; deletions: number }[];
}): IterationEvidenceView {
  const completion = iteration.completionSignalsFired.length > 0
    ? iteration.completionSignalsFired
      .map((signal) => {
        const status = signal.sufficient ? 'enough to stop (after verify)' : 'not enough to stop on its own';
        return `${completionLabel(signal.id)} — ${status}`;
      })
      .join('; ')
    : 'none fired';

  let verifyText: string;
  if (iteration.verifyStatus === 'not-run') {
    verifyText = 'Verify has not run yet (the loop only verifies when it tries to finish).';
  } else if (iteration.verifyFailureKind === 'timeout') {
    verifyText = 'Verify timed out — the command itself did not finish, so this is not a test failure.';
  } else if (iteration.verifyFailureKind === 'infra') {
    verifyText = 'Verify could not run (infrastructure), so this is not a test failure.';
  } else if (iteration.verifyStatus === 'failed') {
    verifyText = 'Verify ran and failed.';
  } else if (iteration.verifyStatus === 'passed') {
    verifyText = 'Verify passed.';
  } else {
    verifyText = `Verify: ${iteration.verifyStatus}`;
  }

  const testsText = iteration.testPassCount === null && iteration.testFailCount === null
    ? 'Tests: not reported'
    : `Tests: ${iteration.testPassCount ?? 0} passed, ${iteration.testFailCount ?? 0} failed`;

  let filesText: string;
  if (iteration.filesChanged.length === 0) {
    filesText = 'Files changed: none reported';
  } else {
    const preview = iteration.filesChanged
      .slice(0, 6)
      .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
      .join(', ');
    const suffix = iteration.filesChanged.length > 6
      ? `, +${iteration.filesChanged.length - 6} more`
      : '';
    filesText = `Files changed: ${preview}${suffix}`;
  }

  return {
    signals: signalViews(iteration.progressSignals),
    completionText: `Completion signals: ${completion}`,
    verifyText,
    testsText,
    filesText,
  };
}

/** Convenience for callers that already have a persisted iteration payload. */
export function evidenceForIteration(iteration: LoopIterationPayload): IterationEvidenceView {
  return buildIterationEvidenceView(iteration);
}
