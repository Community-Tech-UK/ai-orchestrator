/**
 * Repeating stall watchdog for an in-flight ACP `session/prompt` turn.
 *
 * Extracted from AcpCliAdapter so the timer lifecycle can be reasoned about
 * (and unit-tested) on its own. The authoritative liveness owner is still the
 * activity-aware prompt timeout in the adapter; this reports a silence rather
 * than acting on one, so a long wait is visible before the hard timeout fails
 * the turn. It is not inert, though: the report reaches the transcript, and
 * `addToOutputBuffer` deliberately excludes `watchdogWarning` messages from
 * `countAsProcessOutput` so a watchdog cannot postpone the generic
 * stuck-process escalation by reporting on itself.
 *
 * Fires every `intervalMs` of silence until the turn settles or `clear()` is
 * called. The adapter calls `arm()` again on every inbound `session/update`,
 * which re-arms from scratch, so a responsive agent keeps it quiet.
 */

import type { OutputMessage } from '../../../shared/types/instance.types';
import { describeAcpStallWarning, type AcpTurnWait } from './acp-prompt-timeout-policy';

export interface AcpStallReport {
  /** Configured interval, i.e. how long silence must last to be reported. */
  timeoutMs: number;
  /** Age of the whole turn. */
  durationMs: number;
  /** Silence since this interval was armed. */
  inactiveMs: number;
  /** What the turn is waiting on, observed at fire time. */
  wait: AcpTurnWait;
}

export interface AcpStallWatchdogHooks {
  /** False once the turn has settled — the watchdog goes quiet and stays down. */
  isTurnActive(): boolean;
  /** Turn start, for `durationMs`. Null falls back to the interval. */
  turnStartedAt(): number | null;
  /** Observed wait, shared with the prompt-timeout diagnosis so the two agree. */
  classifyWait(): AcpTurnWait;
  /** Report a silence. May synchronously settle the turn (e.g. a listener
   *  terminates the adapter); the watchdog re-checks before re-arming. */
  report(report: AcpStallReport): void;
}

export class AcpStallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by both `arm()` and `clear()`. A fired interval only re-arms if the
   * generation it captured is still current — `this.timer === null` cannot
   * distinguish "cleared" from "currently firing", so it is not a usable guard.
   */
  private generation = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly hooks: AcpStallWatchdogHooks,
  ) {}

  /** Arm (or re-arm) from scratch. No-op when disabled.
   *  Deliberately does NOT require an active turn: the adapter arms before
   *  `session/prompt` is written, so the request id does not exist yet. The
   *  fire path checks instead, and a turn that never starts simply never
   *  reports. */
  arm(): void {
    this.clear();
    if (this.intervalMs <= 0) return;
    this.scheduleNext(this.generation);
  }

  clear(): void {
    this.generation += 1;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(generation: number): void {
    const armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      if (!this.hooks.isTurnActive()) return;

      const startedAt = this.hooks.turnStartedAt();
      this.hooks.report({
        timeoutMs: this.intervalMs,
        durationMs: startedAt === null ? this.intervalMs : Date.now() - startedAt,
        inactiveMs: Date.now() - armedAt,
        wait: this.hooks.classifyWait(),
      });

      // Re-arm for the next interval. Guarded because `report` runs listeners
      // synchronously: one of them may have settled the turn and called
      // `clear()` (or `arm()`), and re-arming after that defeats it.
      if (generation !== this.generation) return;
      if (this.hooks.isTurnActive()) this.scheduleNext(generation);
    }, this.intervalMs);

    // Let the event loop exit with the timer still armed (e.g. during
    // shutdown); the adapter also clears it explicitly on terminate.
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }
}

/** Shared shape for the stall log line and the `stall_warning` event. */
export function buildAcpStallContext(
  report: AcpStallReport,
  adapter: string,
  sessionId: string | null,
  promptRequestId: string | null,
): Record<string, unknown> {
  return {
    adapter,
    sessionId,
    promptRequestId,
    timeoutMs: report.timeoutMs,
    durationMs: report.durationMs,
    inactiveMs: report.inactiveMs,
    waitKind: report.wait.kind,
  };
}

/**
 * Transcript notice for a stalled turn.
 *
 * `system`, not `error`: this narrates a wait the turn may still recover from,
 * matching the app's own stuck-process watchdog (`system` + `watchdogWarning`,
 * instance-manager.ts). As `error` it renders red on every interactive ACP
 * chat — which is what kept this watchdog switched off.
 *
 * Note that the output buffer's repeated-content suppression is gated on
 * `type === 'error'`, and the renderer's identical-message collapse skips
 * `system`, so nothing downstream throttles these. The caller latches instead
 * (see `reportStall` in acp-cli-adapter.ts).
 */
export function buildAcpStallOutputMessage(
  report: AcpStallReport,
  adapter: string,
  id: string,
): OutputMessage {
  return {
    id,
    timestamp: Date.now(),
    type: 'system',
    content: describeAcpStallWarning(report.wait, report.inactiveMs),
    metadata: {
      source: 'acp-stall-warning',
      transport: 'acp',
      adapter,
      watchdogWarning: true,
      severity: 'warning',
      waitKind: report.wait.kind,
      timeoutMs: report.timeoutMs,
      durationMs: report.durationMs,
      inactiveMs: report.inactiveMs,
    },
  };
}
