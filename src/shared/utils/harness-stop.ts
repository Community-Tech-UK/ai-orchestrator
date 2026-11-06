/**
 * A deliberate stop by Harness itself (Oct-2 Phase D Decision 16a), as opposed
 * to a failure or a stop James asked for. Carried on the error that ends the
 * turn and mirrored onto the provider error event's `details`, so the plan
 * queue can park the job as `stopped-by-harness` instead of treating it as a
 * worker error, and nothing retries it automatically.
 */
export type HarnessStopReason = 'turn-token-ceiling';

export interface HarnessStopDetails {
  reason: HarnessStopReason;
  /** Processed tokens in the round when it was stopped. */
  tokens: number;
  /** The setting that triggered the stop. */
  thresholdTokens: number;
}

/** "300,000,000" → "300M" for plain notices. */
export function formatStopTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
}

export function harnessStopNotice(details: HarnessStopDetails): string {
  return `Stopped by Harness: this turn passed ${formatStopTokens(details.thresholdTokens)} tokens.`;
}

/**
 * Why a loop ended when Harness stopped one of its rounds. A loop never retries
 * or moves on after such a stop: the next round would run into the same limit
 * and spend the same tokens again. Starts with `LOOP_HARNESS_STOP_PREFIX` so
 * the loop's end screen can recognise it.
 */
export const LOOP_HARNESS_STOP_PREFIX = 'Harness stopped this loop:';

export function harnessStopLoopEndReason(details: HarnessStopDetails): string {
  return `${LOOP_HARNESS_STOP_PREFIX} a Codex round passed ${formatStopTokens(details.thresholdTokens)} tokens, and running it again would likely spend the same, so it was not retried. `
    + 'To allow bigger rounds, raise "Stop point for Harness work" in Settings, Advanced, under Codex round limits.';
}

export class HarnessStopError extends Error {
  readonly stoppedByHarness = true as const;
  /** The adapter already put the notice in the transcript; callers must not repeat it. */
  readonly surfacedToUser = true as const;

  constructor(readonly details: HarnessStopDetails) {
    super(harnessStopNotice(details));
    this.name = 'HarnessStopError';
  }
}

export function isHarnessStopError(error: unknown): error is HarnessStopError {
  return error instanceof Error && (error as Partial<HarnessStopError>).stoppedByHarness === true;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reads the stop marker from a provider error event's `details`. */
export function harnessStopDetailsOf(eventDetails: unknown): HarnessStopDetails | null {
  const marker = (eventDetails as { stoppedByHarness?: Partial<HarnessStopDetails> } | null | undefined)?.stoppedByHarness;
  return marker && marker.reason === 'turn-token-ceiling' && isCount(marker.tokens) && isCount(marker.thresholdTokens)
    ? { reason: marker.reason, tokens: marker.tokens, thresholdTokens: marker.thresholdTokens }
    : null;
}

/** The `details` object for a provider error event raised by a Harness stop. */
export function harnessStopEventDetails(error: unknown): { stoppedByHarness: HarnessStopDetails } | undefined {
  return isHarnessStopError(error) ? { stoppedByHarness: { ...error.details } } : undefined;
}
