/**
 * Reporting an ACP turn that finished in a suspect state — severed mid-stream,
 * or missing the usage frame that should have accompanied it.
 *
 * An ACP agent whose backend stream is severed mid-turn does not fail the
 * `session/prompt` RPC. It appends the transport error to the assistant text
 * and returns a normal result — observed with `stopReason: 'end_turn'` on a
 * 36-minute turn, which made a truncated reply indistinguishable from a
 * finished one in both the UI and the logs.
 *
 * Only `cursor-agent` has been captured doing this. The detector keys on the
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
 */

import { generateId } from '../../../shared/utils/id-generator';
import type { OutputMessage } from '../../../shared/types/instance.types';

export interface TruncatedAcpTurnInput {
  /** Adapter name, e.g. `cursor-acp`. */
  adapter: string;
  /** The trailing transport error, verbatim. */
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
 * the note points at what is certainly true — a transport error is present in
 * the reply — and offers the remedy conditionally. A wrong note then reads as
 * a redundant hint rather than a false failure.
 */
const NOTICE_LEAD =
  'This turn ended on a provider transport error (shown above). The agent did not '
  + 'choose to stop, so the reply may be cut off — any files it already changed are '
  + 'on disk. If it looks incomplete, send "continue" to resume.';

/**
 * Build the log payload and user-facing notice for a truncated ACP turn.
 * Pure — the caller owns the `logger.warn` and `emit('output')` side effects.
 */
export function describeTruncatedAcpTurn(input: TruncatedAcpTurnInput): TruncatedAcpTurnReport {
  return {
    logMessage: 'ACP turn ended on a provider transport failure — the reply is truncated',
    logFields: {
      adapter: input.adapter,
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
      content: `${NOTICE_LEAD}\n\nProvider error: ${input.failure}`,
      metadata: {
        source: 'acp-transport-failure',
        transport: 'acp',
        adapter: input.adapter,
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
