/**
 * Loop-side handling of provider transport failures that masquerade as
 * iteration output.
 *
 * The detection primitives live in `cli/transport-failure.ts` (shared with the
 * adapter layer, which uses them to spot a transport error appended to an
 * otherwise-real turn). This module owns what the *loop coordinator* does with
 * them.
 *
 * A CLI that cannot reach its backend does not always throw — it prints the
 * failure as the assistant turn and exits 0:
 *
 *   `Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh`
 *
 * The loop coordinator then sees a non-empty output with no tool calls and no
 * file changes, which is neither an invocation error (nothing threw) nor a
 * "void" iteration (the output is non-empty) — so the turn is counted as real
 * work. Observed 2026-09-02 on two concurrent loops: a short DNS outage burned
 * three sub-second iterations each, escalated the no-progress verdict to
 * CRITICAL, and surfaced a false "Re-reading the same files" stuck banner
 * (the stale window signal) while the actual cause was the network.
 *
 * {@link isTransportFailureOnlyOutput} matches the *shape* of such a turn.
 * The coordinator only consults it for turns that changed no files and made no
 * tool calls, so the worst a false positive can do is replay a turn that did
 * nothing — the same cost the void-iteration path already accepts.
 */

import { isTransportFailureOnlyOutput } from '../cli/transport-failure';

export {
  MAX_TRANSPORT_FAILURE_OUTPUT_CHARS,
  TRANSPORT_FAILURE_PATTERNS,
  isTransportFailureOnlyOutput,
} from '../cli/transport-failure';

/**
 * Reason to pause on, when the bounded per-attempt retries are spent and the
 * provider is *still* unreachable: this turn was nothing but a transport error
 * and so was the previous recorded iteration. Two in a row is an outage, not an
 * agent that stalled — and grinding on produces sub-second iterations that the
 * structural detectors then blame on the agent. Nothing was written by either
 * turn, so pausing is safe and the run resumes cleanly.
 *
 * Returns null when this is not that situation (the normal path).
 */
export function transportOutagePauseReason(
  current: { output: string; filesChanged: readonly unknown[]; toolCalls: readonly unknown[] },
  previous: TransportFailureIterationView | null | undefined,
): string | null {
  if (current.filesChanged.length > 0 || current.toolCalls.length > 0) return null;
  if (!isTransportFailureOnlyOutput(current.output)) return null;
  if (!isTransportFailureOnlyIteration(previous)) return null;
  return 'Provider transport failure — the CLI could not reach its backend on two consecutive'
    + ` iterations: ${current.output.trim().slice(0, 200)}`;
}

/** Minimal shape of a recorded iteration needed to re-test it for a transport failure. */
export interface TransportFailureIterationView {
  filesChanged: readonly unknown[];
  toolCalls: readonly unknown[];
  outputFull?: string;
  outputExcerpt: string;
}

/**
 * True when an already-recorded iteration was nothing but a transport failure.
 * Used to recognise a *sustained* outage across iteration boundaries, where the
 * per-attempt retry budget has already been spent.
 */
export function isTransportFailureOnlyIteration(
  iteration: TransportFailureIterationView | null | undefined,
): boolean {
  if (!iteration) return false;
  if (iteration.filesChanged.length > 0 || iteration.toolCalls.length > 0) return false;
  return isTransportFailureOnlyOutput(iteration.outputFull || iteration.outputExcerpt);
}
