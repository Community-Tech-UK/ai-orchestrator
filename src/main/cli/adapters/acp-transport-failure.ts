/**
 * Reporting an ACP turn that finished in a suspect state — severed mid-stream,
 * refused by the provider, or missing the usage frame that should have
 * accompanied it.
 *
 * An ACP agent whose backend stream is severed mid-turn does not fail the
 * `session/prompt` RPC. It appends the transport error to the assistant text
 * and returns a normal result — observed with `stopReason: 'end_turn'` on a
 * 36-minute turn, which made a truncated reply indistinguishable from a
 * finished one in both the UI and the logs. A *refused* turn behaves
 * identically: on 2026-09-03 a 74-minute cursor turn with 1411 tool calls ended
 * `Error: RetriableError: [resource_exhausted] Error`, reported `end_turn`, and
 * was recorded as a clean completion with nothing in the log at all.
 *
 * Only `cursor-agent` has been captured doing this. The detectors key on the
 * gRPC status-chain shape it emits, so Copilot and Grok are covered only if
 * they serialize the same way — unverified until a real sample is captured.
 *
 * This module turns that detection into the two things that were missing: a
 * warn-level log line carrying the corroborating signals, and a visible notice
 * telling the user the reply is cut off and how to resume.
 *
 * The preceding work is real — tool calls ran and files were written — so this
 * deliberately does NOT mark the response degraded. `DegradedReason` feeds the
 * loop coordinator's `classifyDegradedIteration`, where any value routes the
 * iteration into retry-or-pause; deciding that a truncated-but-productive turn
 * should stop a loop is a separate call from making the truncation visible.
 *
 * It also deliberately does NOT park the instance on the provider-limit
 * resume path. A refusal status carries no reset hint, and `resource_exhausted`
 * does not say whether an account quota or a single oversized request was
 * exhausted. Parking until an invented reset time would wedge a session whose
 * next, smaller turn would have succeeded.
 */

import { generateId } from '../../../shared/utils/id-generator';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { findTrailingProviderRefusal, findTrailingTransportFailure } from '../transport-failure';

/**
 * Why a turn ended on a serialized provider error: the connection to the
 * backend failed (`transport`), or the backend declined to serve the request
 * (`refusal`). Both truncate the reply; only the remedy differs.
 */
export type TurnEndingFailureKind = 'transport' | 'refusal';

export interface TurnEndingFailure {
  kind: TurnEndingFailureKind;
  /** The trailing error line, verbatim. */
  failure: string;
}

/**
 * Classify the provider error an ACP turn ended on, or null when it ended
 * normally.
 *
 * Transport is tested first: it is the better-corroborated of the two (an errno
 * or syscall backs it up, not just a status code), so when both could fire the
 * more specific diagnosis wins. In practice they are mutually exclusive — no
 * allowlisted refusal code is transport evidence — but the order makes that
 * independent of the allowlist staying disjoint as it grows.
 */
export function classifyTurnEndingFailure(responseText: string): TurnEndingFailure | null {
  const transport = findTrailingTransportFailure(responseText);
  if (transport) return { kind: 'transport', failure: transport };
  const refusal = findTrailingProviderRefusal(responseText);
  if (refusal) return { kind: 'refusal', failure: refusal };
  return null;
}

/**
 * Response metadata recording the failure. Nothing outside this module reads
 * either key today — the user-visible signal is the emitted notice — so these
 * are diagnostic breadcrumbs on the response for whoever inspects it next.
 * A refusal gets its own key rather than being flattened into `transportFailure`
 * because "we could not reach the provider" and "the provider said no" are
 * different facts, and a future consumer that conflates them would misdiagnose.
 */
export function turnEndingFailureMetadata(failure: TurnEndingFailure): Record<string, unknown> {
  return {
    truncatedTurn: true,
    ...(failure.kind === 'transport'
      ? { transportFailure: failure.failure }
      : { providerRefusal: failure.failure }),
  };
}

export interface TruncatedAcpTurnInput {
  /** Adapter name, e.g. `cursor-acp`. */
  adapter: string;
  /** Whether the backend was unreachable or refused the request. */
  kind: TurnEndingFailureKind;
  /** The trailing provider error, verbatim. */
  failure: string;
  /** `stopReason` the agent reported — normally 'end_turn', which is the point. */
  stopReason?: string;
  /**
   * Whether the agent reported real token usage for this turn. Recorded as
   * diagnostic context only — a severed stream drops the usage frame, but many
   * agents never report usage at all, so this cannot gate the detection
   * without silently exempting every one of them.
   */
  providerUsageReported: boolean;
  durationMs: number;
  contentLength: number;
}

export interface TruncatedAcpTurnReport {
  logMessage: string;
  logFields: Record<string, unknown>;
  notice: OutputMessage;
}

/**
 * Deliberately does NOT assert that the turn was truncated. The detection is
 * text classification and can misfire on a terse technical closing line, so
 * each note points at what is certainly true — a provider error is present in
 * the reply — and offers the remedy conditionally. A wrong note then reads as
 * a redundant hint rather than a false failure.
 *
 * The refusal wording adds the one thing a user cannot infer from the status
 * code: a refusal is a capacity decision rather than a fault in the work, and
 * resuming into the same oversized session invites the same answer.
 */
const NOTICE_LEAD: Record<TurnEndingFailureKind, string> = {
  transport:
    'This turn ended on a provider transport error (shown above). The agent did not '
    + 'choose to stop, so the reply may be cut off — any files it already changed are '
    + 'on disk. If it looks incomplete, send "continue" to resume.',
  refusal:
    'This turn ended on a provider refusal (shown above). The agent did not choose to '
    + 'stop, so the reply may be cut off — any files it already changed are on disk. A '
    + 'refusal is normally a quota or capacity limit rather than a problem with the '
    + 'work, and a very long turn makes one more likely. If it looks incomplete, send '
    + '"continue" to resume, or start a fresh session so the retry carries less context.',
};

const LOG_MESSAGE: Record<TurnEndingFailureKind, string> = {
  transport: 'ACP turn ended on a provider transport failure — the reply is truncated',
  refusal: 'ACP turn ended on a provider refusal — the reply is truncated',
};

/** Notice `metadata.source`, kept distinct so the two causes stay separable in logs. */
const NOTICE_SOURCE: Record<TurnEndingFailureKind, string> = {
  transport: 'acp-transport-failure',
  refusal: 'acp-provider-refusal',
};

/**
 * Build the log payload and user-facing notice for a truncated ACP turn.
 * Pure — the caller owns the `logger.warn` and `emit('output')` side effects.
 */
export function describeTruncatedAcpTurn(input: TruncatedAcpTurnInput): TruncatedAcpTurnReport {
  return {
    logMessage: LOG_MESSAGE[input.kind],
    logFields: {
      adapter: input.adapter,
      kind: input.kind,
      failure: input.failure,
      stopReason: input.stopReason,
      providerUsageReported: input.providerUsageReported,
      durationMs: input.durationMs,
      contentLength: input.contentLength,
    },
    notice: {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: `${NOTICE_LEAD[input.kind]}\n\nProvider error: ${input.failure}`,
      metadata: {
        source: NOTICE_SOURCE[input.kind],
        transport: 'acp',
        adapter: input.adapter,
        failureKind: input.kind,
        recoverable: true,
        truncatedTurn: true,
        providerUsageReported: input.providerUsageReported,
        stopReason: input.stopReason,
      },
    },
  };
}

/**
 * How long a turn must run before *absent* usage is suspicious rather than
 * merely unsupported. Below this a turn that reports nothing is unremarkable —
 * plenty of agents never report usage at all. Above it the turn did enough work
 * that a dropped usage frame is a real possibility worth a line in the log.
 *
 * The incident this guards ran for 36 minutes.
 */
export const MISSING_USAGE_WARN_MIN_DURATION_MS = 60_000;

export type MissingUsageReason = 'usage-regression' | 'substantial-turn';

/**
 * Why a turn's missing usage deserves a warning rather than the once-per-session
 * info line, or null when it is unremarkable.
 *
 * - `usage-regression` — this session reported usage before and has now stopped,
 *   so a frame went missing rather than the agent not supporting usage.
 * - `substantial-turn` — the session has never reported usage, but this turn ran
 *   long enough that its silence is worth surfacing once.
 *
 * Callers must fire at most one warning per session; both reasons describe a
 * session-level condition, so repeating them per turn is pure noise.
 */
export function classifyMissingUsage(input: {
  hasReportedUsage: boolean;
  durationMs: number;
}): MissingUsageReason | null {
  if (input.hasReportedUsage) return 'usage-regression';
  if (input.durationMs >= MISSING_USAGE_WARN_MIN_DURATION_MS) return 'substantial-turn';
  return null;
}
