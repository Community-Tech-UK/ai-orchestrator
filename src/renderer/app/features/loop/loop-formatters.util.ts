/**
 * Pure formatting helpers for Loop Mode UI.
 *
 * Extracted from `LoopControlComponent` so the same labels/durations/
 * timestamps can be reused by sibling components (the past-runs panel,
 * the active-loop strip, future detail views) without duplicating the
 * arithmetic. All functions are pure: same input → same output, no
 * Angular dependencies, trivially unit-testable.
 *
 * Time-relative helpers (`relativeTime`) intentionally don't read a
 * "now" signal themselves — callers re-render on whatever cadence they
 * need (the loop control component runs a 1Hz tick) and pass `now` in
 * if they want to override (mostly for tests).
 */

/** Renders a wall-clock duration in milliseconds as `Ns`, `NmSs`, `NhMm`,
 *  or `NdNhNm`. Used for "loop ran for 9m3s"-style summaries. */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m${Math.floor((ms % 60_000) / 1000)}s`;
  const hours = Math.floor(mins / 60);
  if (ms > 24 * 60 * 60_000) return `${Math.floor(hours / 24)}d${hours % 24}h${mins % 60}m`;
  return `${hours}h${mins % 60}m`;
}

/** Renders a token count compactly: `850 tok`, `12.3k tok`, `1.20M tok`. */
export function humanTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(2)}M tok`;
}

/** `HH:MM:SS` (24-hour, zero-padded). Used for the activity feed. */
export function shortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Extract a human-readable argument summary from a loop activity `detail`
 * record — the actual command / file / pattern behind an otherwise opaque
 * "Using tool: Bash" row.
 *
 * Tool activity carries `detail.input` (the tool's arguments) end-to-end
 * from the CLI adapter (e.g. `{ name: 'Bash', input: { command } }`), but
 * the activity feed previously rendered only the bare `message`, so every
 * tool call collapsed to the same blank-looking line. This recovers the
 * action-defining field per common tool shape, falling back to a compact
 * JSON of the remaining args. Whitespace is collapsed to keep it to one
 * legible line; returns `''` when there's nothing useful to show.
 */
export function summarizeToolDetail(detail?: Record<string, unknown>): string {
  if (!detail) return '';
  const input = isPlainRecord(detail['input']) ? detail['input'] : detail;
  const str = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  };

  // Most action-defining field first, per common Claude/CLI tool schemas.
  const command = str('command');
  if (command) return command;

  const pattern = str('pattern');
  if (pattern) {
    const path = str('path');
    return path ? `${pattern}  ·  ${path}` : pattern;
  }

  const filePath = str('file_path') || str('notebook_path') || str('path');
  if (filePath) return filePath;

  const url = str('url');
  if (url) return url;

  const query = str('query');
  if (query) return query;

  const prose = str('prompt') || str('description');
  if (prose) return prose;

  // Fallback: compact JSON of the args minus identity/timing noise.
  const noise = new Set(['id', 'name', 'startedAt', 'durationMs']);
  const slim: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!noise.has(key)) slim[key] = input[key];
  }
  if (Object.keys(slim).length === 0) return '';
  try {
    return JSON.stringify(slim).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** Activity-feed event-kind label. Falls through to the raw kind for
 *  forward-compat with new event types added later by the coordinator. */
export function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'tool_use': return 'tool';
    case 'input_required': return 'input';
    case 'stream-idle': return 'quiet';
    default: return kind;
  }
}

/**
 * Friendly label for a *terminal* loop status — what we show on the
 * "Loop ended — …" summary card. Confined to the five terminal states
 * by its parameter type so callers don't accidentally render
 * "running ✓" on the summary.
 */
export type TerminalLoopStatus =
  | 'completed'
  | 'completed-needs-review'
  | 'cancelled'
  | 'failed'
  | 'cap-reached'
  | 'error'
  | 'no-progress'
  | 'provider-limit'
  | 'cost-exceeded'
  | 'needs-human-arbitration'
  | 'reviewer-unreliable'
  | 'reviewer-unavailable'
  | 'builder-unreliable';

export function terminalStatusLabel(status: TerminalLoopStatus): string {
  switch (status) {
    case 'completed':              return 'completed ✓';
    case 'completed-needs-review': return 'needs review';
    case 'cancelled':              return 'cancelled';
    case 'failed':                 return 'failed';
    case 'cap-reached':            return 'cap reached';
    case 'error':                  return 'error';
    case 'no-progress':            return 'no progress';
    case 'provider-limit':         return 'provider limit';
    case 'cost-exceeded':          return 'cost exceeded';
    case 'needs-human-arbitration': return 'needs arbitration';
    case 'reviewer-unreliable':    return 'reviewer unreliable';
    case 'reviewer-unavailable':   return 'reviewer unavailable';
    case 'builder-unreliable':     return 'builder unreliable';
  }
}

/**
 * Friendly label for *any* loop status — used for the persisted
 * past-runs list which can include running/paused entries (e.g. when
 * the app was killed mid-run). Returns the raw status verbatim for any
 * unrecognized value so a future LoopStatus addition still renders
 * something rather than a blank cell.
 */
export function loopStatusLabel(status: string): string {
  switch (status) {
    case 'completed':              return 'completed';
    case 'completed-needs-review': return 'needs review';
    case 'cancelled':              return 'cancelled';
    case 'failed':                 return 'failed';
    case 'cap-reached':            return 'cap';
    case 'error':                  return 'error';
    case 'no-progress':            return 'no-progress';
    case 'provider-limit':         return 'provider limit';
    case 'cost-exceeded':          return 'cost exceeded';
    case 'needs-human-arbitration': return 'needs arbitration';
    case 'reviewer-unreliable':    return 'reviewer unreliable';
    case 'reviewer-unavailable':   return 'reviewer unavailable';
    case 'builder-unreliable':     return 'builder unreliable';
    case 'paused':                 return 'paused';
    case 'running':                return 'running';
    default:                       return status;
  }
}

// ============ LF-8: loop visual model ============

/**
 * The always-on status pill kind. Maps a live `LoopStatus` (plus, for paused
 * loops, *why* it paused) to a small set of legible states so the user can
 * answer "running / paused-and-why / done / needs-review / stopped" from the
 * strip alone without opening the inspector.
 */
export type LoopStatusPillKind =
  | 'running'
  | 'awaiting-review'
  | 'no-progress'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'needs-review'
  | 'stopped';

export interface LoopStatusPill {
  kind: LoopStatusPillKind;
  /** Uppercase label, e.g. "RUNNING", "NEEDS REVIEW". */
  label: string;
}

/**
 * Derive the status pill for a live or terminal loop. `bannerKind`/`signalId`
 * disambiguate the three pause flavours (awaiting operator review vs. structural
 * no-progress vs. a BLOCKED.md / block intent) that previously all rendered as
 * one ambiguous orange bar.
 */
export function loopStatusPill(input: {
  status: string;
  manualReviewOnly?: boolean;
  lastCompletionOutcome?: string;
  bannerKind?: 'no-progress' | 'claimed-failed' | null;
  bannerSignalId?: string | null;
}): LoopStatusPill {
  switch (input.status) {
    case 'running':                return { kind: 'running', label: 'RUNNING' };
    case 'completed':              return { kind: 'done', label: 'DONE' };
    case 'completed-needs-review': return { kind: 'needs-review', label: 'NEEDS REVIEW' };
    case 'paused': {
      const reason = loopPauseReason(input);
      switch (reason) {
        case 'awaiting-review': return { kind: 'awaiting-review', label: 'NEEDS REVIEW' };
        case 'blocked':         return { kind: 'blocked', label: 'BLOCKED' };
        case 'no-progress':     return { kind: 'no-progress', label: 'PAUSED · NO PROGRESS' };
        default:                return { kind: 'paused', label: 'PAUSED' };
      }
    }
    case 'cancelled':   return { kind: 'stopped', label: 'STOPPED' };
    case 'failed':      return { kind: 'stopped', label: 'FAILED' };
    case 'error':       return { kind: 'stopped', label: 'ERROR' };
    case 'cap-reached': return { kind: 'stopped', label: 'CAP REACHED' };
    case 'no-progress': return { kind: 'no-progress', label: 'NO PROGRESS' };
    case 'provider-limit': return { kind: 'stopped', label: 'PROVIDER LIMIT' };
    case 'cost-exceeded': return { kind: 'stopped', label: 'COST EXCEEDED' };
    case 'needs-human-arbitration': return { kind: 'needs-review', label: 'NEEDS ARBITRATION' };
    case 'reviewer-unreliable': return { kind: 'stopped', label: 'REVIEWER UNRELIABLE' };
    case 'reviewer-unavailable': return { kind: 'stopped', label: 'REVIEWER UNAVAILABLE' };
    case 'builder-unreliable': return { kind: 'stopped', label: 'BUILDER UNRELIABLE' };
    default:            return { kind: 'paused', label: String(input.status).toUpperCase() };
  }
}

export type LoopPauseReason = 'awaiting-review' | 'no-progress' | 'blocked' | 'paused';

/**
 * Classify *why* a paused loop is paused, from data the store already has.
 * A BLOCKED signal wins; an unverifiable completion is awaiting operator
 * sign-off; a no-progress banner is structural; otherwise it's a plain pause.
 * `manualReviewOnly` by itself is just startup config, not evidence that the
 * loop has declared completion.
 */
export function loopPauseReason(input: {
  manualReviewOnly?: boolean;
  lastCompletionOutcome?: string;
  bannerKind?: 'no-progress' | 'claimed-failed' | null;
  bannerSignalId?: string | null;
}): LoopPauseReason {
  if (input.bannerKind === 'no-progress' && input.bannerSignalId === 'BLOCKED') return 'blocked';
  if (input.lastCompletionOutcome === 'unverifiable') return 'awaiting-review';
  if (input.bannerKind === 'no-progress') return 'no-progress';
  return 'paused';
}

export type GateStepState = 'done' | 'blocked' | 'pending' | 'skipped';

export interface LoopGateStep {
  key: 'declared' | 'verify' | 'rename' | 'review' | 'stop';
  label: string;
  state: GateStepState;
}

/**
 * Compute the completion-gate stepper: declared → verify → rename → review →
 * stop, with the blocked step highlighted. This is the single legible answer to
 * "the loop says it's done — what is it waiting on?" (loopfixex §12.2 / LF-8).
 * Derived purely from data the store already holds; no backend change.
 */
export function completionGateSteps(input: {
  status: string;
  verifyStatus?: 'not-run' | 'passed' | 'failed';
  renameObserved?: boolean;
  requireRename?: boolean;
  manualReviewOnly?: boolean;
  freshEyesEnabled?: boolean;
  lastCompletionOutcome?: string;
}): LoopGateStep[] {
  const {
    status,
    verifyStatus = 'not-run',
    renameObserved = false,
    requireRename = false,
    manualReviewOnly = false,
    freshEyesEnabled = false,
    lastCompletionOutcome,
  } = input;
  const terminalDone = status === 'completed' || status === 'completed-needs-review';
  const attempted = terminalDone || lastCompletionOutcome !== undefined;

  const declared: GateStepState = attempted ? 'done' : 'pending';

  let verify: GateStepState;
  if (manualReviewOnly) verify = 'skipped';
  else if (verifyStatus === 'passed' || terminalDone) verify = 'done';
  else if (lastCompletionOutcome === 'verify-failed' || verifyStatus === 'failed') verify = 'blocked';
  else verify = 'pending';

  let rename: GateStepState;
  if (!requireRename) rename = 'skipped';
  else if (renameObserved) rename = 'done';
  else if (lastCompletionOutcome === 'rename-gate') rename = 'blocked';
  else rename = 'pending';

  let review: GateStepState;
  if (!freshEyesEnabled && !manualReviewOnly) review = 'skipped';
  else if (lastCompletionOutcome === 'review-blocked'
           || (manualReviewOnly && status === 'paused' && lastCompletionOutcome === 'unverifiable')) review = 'blocked';
  else if (terminalDone) review = 'done';
  else review = 'pending';

  const stop: GateStepState = terminalDone ? 'done' : 'pending';

  return [
    { key: 'declared', label: 'declared', state: declared },
    { key: 'verify', label: 'verify', state: verify },
    { key: 'rename', label: 'rename', state: rename },
    { key: 'review', label: 'review', state: review },
    { key: 'stop', label: 'stop', state: stop },
  ];
}

/** "5s ago" / "2m ago" / "3h ago" / "4d ago" / "Apr 12". `now` exists for
 *  test seams; production callers omit it and let `Date.now()` win. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

/** Locale-formatted full timestamp (used as a tooltip on relative-time
 *  cells so users can hover to see exactly when something happened). */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Cents → `$X.YY`. Trivial helper but keeps `(cost / 100).toFixed(2)`
 *  out of templates, where the implicit number→string coercion is easy
 *  to mis-key. */
export function formatCostCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ============ Inspector progress header ============

export interface InspectorProgressMetric {
  key: 'iterations' | 'time' | 'tokens' | 'cost';
  label: string;
  /** "5 / 20" style current-vs-cap text. */
  valueText: string;
  /** 0–100 bar fill, or null when the budget is uncapped (no bar). */
  pct: number | null;
  tooltip: string;
}

export interface InspectorProgressView {
  status: string;
  statusLabel: string;
  headline: string;
  stageText: string;
  metrics: InspectorProgressMetric[];
  completionText: string | null;
}

/**
 * Build the inspector's at-a-glance progress header — the single answer to
 * "is this loop nearly finished, or hasn't it started?". A loop terminates
 * when the completion gate clears OR any *capped* budget is exhausted, so we
 * emit a progress bar per cap (iterations / wall-time / tokens / cost); the
 * fullest bar is the binding constraint. Uncapped budgets (`null` cap) show the
 * running total with `pct: null` and no bar. Pure: callers pass live `elapsedMs`
 * (driven by their own tick) and the pre-resolved status pill.
 */
export function buildInspectorProgress(input: {
  status: string;
  statusPillKind: string | null;
  statusPillLabel: string | null;
  totalIterations: number;
  totalTokens: number;
  totalCostCents: number;
  currentStage: string;
  iterationsOnCurrentStage: number;
  completionAttempts: number;
  lastCompletionOutcome?: string;
  /** Seq of the in-flight iteration (0-based), or null when none is running. */
  runningSeq: number | null;
  elapsedMs: number;
  caps: {
    maxIterations: number | null;
    maxWallTimeMs: number;
    maxTokens: number | null;
    maxCostCents: number | null;
  };
}): InspectorProgressView {
  const { caps } = input;
  // Completed iterations + the one in flight (seq is 0-based; totalIterations
  // is only incremented when an iteration ends).
  const iterCount = input.runningSeq !== null ? input.runningSeq + 1 : input.totalIterations;

  const pct = (value: number, cap: number | null): number | null =>
    cap && cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : null;
  const capText = (cap: number | null, fmt: (n: number) => string): string =>
    cap === null ? '∞' : fmt(cap);

  const metrics: InspectorProgressMetric[] = [
    {
      key: 'iterations',
      label: 'Iterations',
      valueText: `${iterCount} / ${capText(caps.maxIterations, String)}`,
      pct: pct(iterCount, caps.maxIterations),
      tooltip: caps.maxIterations === null ? 'No iteration cap' : `${iterCount} of ${caps.maxIterations} iterations`,
    },
    {
      key: 'time',
      label: 'Time',
      valueText: `${humanDuration(input.elapsedMs)} / ${humanDuration(caps.maxWallTimeMs)}`,
      pct: pct(input.elapsedMs, caps.maxWallTimeMs),
      tooltip: `Elapsed wall time vs ${humanDuration(caps.maxWallTimeMs)} cap`,
    },
    {
      key: 'tokens',
      label: 'Tokens',
      valueText: `${humanTokens(input.totalTokens)} / ${capText(caps.maxTokens, humanTokens)}`,
      pct: pct(input.totalTokens, caps.maxTokens),
      tooltip: caps.maxTokens === null ? 'No token cap' : `${humanTokens(input.totalTokens)} of ${humanTokens(caps.maxTokens)}`,
    },
    {
      key: 'cost',
      label: 'Cost',
      valueText: `${formatCostCents(input.totalCostCents)} / ${capText(caps.maxCostCents, formatCostCents)}`,
      pct: pct(input.totalCostCents, caps.maxCostCents),
      tooltip: caps.maxCostCents === null ? 'No cost cap' : `${formatCostCents(input.totalCostCents)} of ${formatCostCents(caps.maxCostCents)}`,
    },
  ];

  let headline: string;
  if (input.runningSeq !== null) {
    headline = input.totalIterations === 0
      ? `Iteration ${input.runningSeq} running · just getting started`
      : `Iteration ${input.runningSeq} running`;
  } else if (input.status === 'paused') {
    headline = `Paused after ${input.totalIterations} iteration${input.totalIterations === 1 ? '' : 's'}`;
  } else {
    headline = `${input.totalIterations} iteration${input.totalIterations === 1 ? '' : 's'} run`;
  }

  const onStage = input.iterationsOnCurrentStage;
  const stageText = `${input.currentStage} · ${onStage} iter${onStage === 1 ? '' : 's'} on stage`;

  const completionText = input.completionAttempts > 0
    ? `Completion attempt ${input.completionAttempts}${input.lastCompletionOutcome ? ' · ' + input.lastCompletionOutcome : ''}`
    : null;

  return {
    status: input.statusPillKind ?? input.status,
    statusLabel: input.statusPillLabel ?? input.status.toUpperCase(),
    headline,
    stageText,
    metrics,
    completionText,
  };
}
