import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('StuckProcessDetector');

const CHECK_INTERVAL_MS = 10_000;

/**
 * If wall-clock gap between consecutive checkAll() calls exceeds this,
 * assume the system was asleep (laptop lid close, VM pause, etc.).
 * All tracker timers are reset to prevent mass false-kills on wake.
 */
const SLEEP_DETECTION_THRESHOLD_MS = 60_000;

interface TimeoutConfig {
  softMs: number;
  hardMs: number;
}

const TIMEOUTS: Record<string, TimeoutConfig> = {
  // D5: soft threshold reduced 120s → 60s for generating; 600s → 240s for tool_executing.
  generating: { softMs: 60_000, hardMs: 240_000 },
  tool_executing: { softMs: 240_000, hardMs: 1_200_000 },
};

/**
 * When the CLI process is confirmed alive (e.g. running Agent subagents),
 * multiply timeouts by this factor before emitting stuck events.
 * This prevents killing instances that are actively working but not
 * producing visible output (long-running tool chains, subagent spawns).
 */
const ALIVE_PROCESS_TIMEOUT_MULTIPLIER = 2;

/**
 * Grace window for a live process sitting in `tool_executing`.
 *
 * A process blocked in a tool call is legitimately waiting on a long-running
 * tool — most often a `codex`/`gemini` MCP sub-agent review — which emits no
 * output for many minutes. Logs confirmed the false alarm this caused:
 * `state=tool_executing, processAlive=true`, ~630s of silence surfaced
 * "Instance may be stuck — will auto-restart", and the eventual hard kill
 * (40min for an alive tool turn) would abort a legitimate review.
 *
 * While the process is demonstrably alive and under this ceiling, stuck
 * escalation is suppressed entirely (the silence is expected). Past the
 * ceiling, normal soft→hard escalation resumes so a genuinely hung tool is
 * still caught. Scoped to `tool_executing` only — prolonged silence while
 * `generating` is genuinely suspect and keeps its existing thresholds.
 */
const TOOL_EXECUTING_ALIVE_GRACE_MS = 1_200_000; // 20 minutes

/**
 * Maximum number of times we defer a timeout for a still-alive process,
 * by state. `tool_executing` gets more headroom (tools can legitimately
 * run for several minutes); all other states (e.g. `generating`) get just
 * one deferral so warnings surface promptly. D5.
 */
const MAX_ALIVE_DEFERRALS_BY_STATE: Record<string, number> = {
  tool_executing: 3,
};
const DEFAULT_MAX_ALIVE_DEFERRALS = 1;

/**
 * Timeout for detecting when a subprocess is waiting for interactive input
 * it will never receive (e.g., `npm init` without `-y`, `git rebase -i`).
 * Shorter than other timeouts since interactive prompts happen quickly.
 * Inspired by Claude Code 2.1.84 background task interactive-prompt detection.
 */
const INTERACTIVE_PROMPT_DETECT_MS = 45_000;

export type ProcessState = 'generating' | 'tool_executing' | 'idle';

export interface StuckDetectorOptions {
  /**
   * Callback to check whether the CLI process for a given instance is still
   * alive and running. When the process is alive, timeouts are extended to
   * avoid killing instances that are actively working but silent (e.g.
   * running Agent subagents, long bash commands).
   */
  isProcessAlive?: (instanceId: string) => boolean;
  /**
   * Callback to check whether work outside the provider process is still
   * actively handling this instance's turn. Examples include orchestration
   * children and consensus queries. While true, silence from the parent
   * provider process is expected and should not produce stuck warnings.
   */
  hasExternalActivity?: (instanceId: string) => boolean;
  /**
   * Grace window (ms) for a live process sitting in `tool_executing` before
   * stuck escalation resumes. Long MCP sub-agent reviews (codex/gemini) can be
   * silent for many minutes; raise this for workloads with long tool turns.
   * Defaults to `TOOL_EXECUTING_ALIVE_GRACE_MS`.
   */
  toolExecutingAliveGraceMs?: number;
}

interface ProcessTracker {
  lastOutputAt: number;
  instanceState: ProcessState;
  softWarningEmitted: boolean;
  /** Whether stdout has gone silent while stderr/process is alive (interactive prompt indicator) */
  interactivePromptWarningEmitted: boolean;
  /** Last time we saw stderr output (interactive prompts often write to stderr) */
  lastStderrAt: number;
  /** How many times we've deferred the timeout because process was alive */
  aliveDeferrals: number;
  /**
   * Signature of the last *content* output seen (P4.5/D5 evidence-hash fence).
   * Identical repeated output (e.g. a looping error or keep-alive noise) is
   * liveness, not progress — it must not perpetually reset the stuck clock.
   * `null` until the first content output. Heartbeats don't touch this.
   */
  lastEvidenceSignature: string | null;
}

/**
 * Compact, timestamp-free signature of an output payload (P4.5). Cheap to
 * compute on the hot path: combines length with a small fixed sample so that
 * identical content yields an identical signature while genuinely new content
 * differs. Not cryptographic — only equality matters.
 */
function evidenceSignature(content: string): string {
  const len = content.length;
  if (len <= 96) return `${len}:${content}`;
  return `${len}:${content.slice(0, 48)}:${content.slice(-48)}`;
}

export class StuckProcessDetector extends EventEmitter {
  private trackers = new Map<string, ProcessTracker>();
  private checkInterval: NodeJS.Timeout | null = null;
  private isProcessAlive: ((instanceId: string) => boolean) | undefined;
  private hasExternalActivity: ((instanceId: string) => boolean) | undefined;
  private readonly toolExecutingAliveGraceMs: number;
  private lastCheckTime = Date.now();

  constructor(options?: StuckDetectorOptions) {
    super();
    this.isProcessAlive = options?.isProcessAlive;
    this.hasExternalActivity = options?.hasExternalActivity;
    this.toolExecutingAliveGraceMs =
      options?.toolExecutingAliveGraceMs ?? TOOL_EXECUTING_ALIVE_GRACE_MS;
    this.checkInterval = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    if (this.checkInterval.unref) this.checkInterval.unref();
    registerCleanup(() => this.shutdown());
  }

  startTracking(instanceId: string): void {
    this.trackers.set(instanceId, {
      lastOutputAt: Date.now(),
      instanceState: 'idle',
      softWarningEmitted: false,
      interactivePromptWarningEmitted: false,
      lastStderrAt: 0,
      aliveDeferrals: 0,
      lastEvidenceSignature: null,
    });
  }

  stopTracking(instanceId: string): void {
    this.trackers.delete(instanceId);
  }

  /**
   * Record output activity for an instance.
   *
   * @param content Optional output payload. When provided, the evidence-hash
   *   fence (P4.5/D5) applies: if the content is byte-identical to the previous
   *   content output, it is treated as liveness — NOT progress — and the stuck
   *   clock is left running so looping/repeated output can still be detected as
   *   stuck. New content fully resets the clock. Content-free calls (heartbeats)
   *   reset the clock as before, preserving tolerance for long internal turns.
   */
  recordOutput(instanceId: string, content?: string): void {
    const tracker = this.trackers.get(instanceId);
    if (!tracker) return;

    if (content !== undefined) {
      const signature = evidenceSignature(content);
      if (tracker.lastEvidenceSignature !== null && signature === tracker.lastEvidenceSignature) {
        // Evidence unchanged — repeated identical output is not progress. Keep
        // the stuck clock running (the fence) but don't escalate here.
        return;
      }
      tracker.lastEvidenceSignature = signature;
    }

    tracker.lastOutputAt = Date.now();
    tracker.softWarningEmitted = false;
    tracker.interactivePromptWarningEmitted = false;
  }

  /**
   * Record stderr output. When stderr arrives but stdout is silent,
   * this is a strong indicator of an interactive prompt waiting for input.
   */
  recordStderr(instanceId: string): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.lastStderrAt = Date.now();
    }
  }

  updateState(instanceId: string, state: ProcessState): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.instanceState = state;
      tracker.lastOutputAt = Date.now();
      tracker.softWarningEmitted = false;
      tracker.interactivePromptWarningEmitted = false;
      tracker.aliveDeferrals = 0;
      // New phase — start a fresh evidence baseline so the fence compares within
      // the current state, not across a state transition.
      tracker.lastEvidenceSignature = null;
    }
  }

  shutdown(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.trackers.clear();
  }

  private checkAll(): void {
    const now = Date.now();
    const checkGap = now - this.lastCheckTime;
    this.lastCheckTime = now;

    // Sleep/wake detection: if the gap between checks far exceeds the
    // interval, the system was likely asleep. Reset all timers to prevent
    // every tracked instance from immediately triggering hard timeouts.
    if (checkGap > SLEEP_DETECTION_THRESHOLD_MS) {
      logger.info('System sleep detected — resetting stuck-process timers', {
        gapMs: checkGap,
        expectedMs: CHECK_INTERVAL_MS,
        trackerCount: this.trackers.size,
      });
      for (const tracker of this.trackers.values()) {
        tracker.lastOutputAt = now;
        tracker.softWarningEmitted = false;
        tracker.interactivePromptWarningEmitted = false;
        tracker.aliveDeferrals = 0;
      }
      return;
    }

    for (const [instanceId, tracker] of this.trackers) {
      if (tracker.instanceState === 'idle') continue;

      const config = TIMEOUTS[tracker.instanceState];
      if (!config) continue;

      if (this.hasExternalActivity?.(instanceId)) {
        tracker.lastOutputAt = now;
        tracker.softWarningEmitted = false;
        tracker.interactivePromptWarningEmitted = false;
        tracker.aliveDeferrals = 0;
        continue;
      }

      const elapsed = now - tracker.lastOutputAt;

      // If the CLI process is still alive (e.g. running Agent subagents,
      // long bash commands), extend the hard kill threshold to avoid
      // terminating active work. Soft warnings use the base threshold
      // but are deferred while the process is alive (up to a cap).
      const processAlive = this.isProcessAlive?.(instanceId) ?? false;

      // Long-tool grace: a live process blocked in `tool_executing` is
      // legitimately waiting on a long-running tool (e.g. a codex/gemini MCP
      // sub-agent review) that emits no output for minutes. While alive and
      // under the grace ceiling, suppress the soft/hard stuck escalation only
      // (interactive-prompt detection below still runs); past the ceiling the
      // normal escalation resumes so a genuinely hung tool is still caught.
      const inToolExecutingGrace =
        tracker.instanceState === 'tool_executing' &&
        processAlive &&
        elapsed < this.toolExecutingAliveGraceMs;

      const hardMultiplier = processAlive ? ALIVE_PROCESS_TIMEOUT_MULTIPLIER : 1;
      const effectiveHardMs = config.hardMs * hardMultiplier;

      if (!inToolExecutingGrace && elapsed >= effectiveHardMs) {
        logger.warn('Process stuck — hard timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
          processAlive,
          aliveDeferrals: tracker.aliveDeferrals,
        });
        this.emit('process:stuck', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        this.trackers.delete(instanceId);
      } else if (!inToolExecutingGrace && elapsed >= config.softMs && !tracker.softWarningEmitted) {
        // If process is alive and we haven't exhausted deferrals, defer
        // instead of warning — the instance is actively working.
        const maxDeferrals = MAX_ALIVE_DEFERRALS_BY_STATE[tracker.instanceState] ?? DEFAULT_MAX_ALIVE_DEFERRALS;
        if (processAlive && tracker.aliveDeferrals < maxDeferrals) {
          tracker.aliveDeferrals++;
          logger.info('Process alive — deferring stuck warning', {
            instanceId,
            state: tracker.instanceState,
            elapsedMs: elapsed,
            deferral: tracker.aliveDeferrals,
            maxDeferrals,
          });
          continue;
        }

        logger.warn('Process may be stuck — soft timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
          processAlive,
        });
        tracker.softWarningEmitted = true;
        this.emit('process:suspect-stuck', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
      }

      // Interactive prompt detection: stdout silent but stderr recently active
      // suggests a subprocess wrote a prompt to stderr and is waiting for stdin.
      // Inspired by Claude Code 2.1.84 interactive-prompt surface detection.
      if (
        !tracker.interactivePromptWarningEmitted &&
        tracker.instanceState === 'tool_executing' &&
        elapsed >= INTERACTIVE_PROMPT_DETECT_MS &&
        tracker.lastStderrAt > tracker.lastOutputAt &&
        now - tracker.lastStderrAt < INTERACTIVE_PROMPT_DETECT_MS
      ) {
        logger.warn('Process may be waiting for interactive input', {
          instanceId,
          stdoutSilentMs: elapsed,
          lastStderrMs: now - tracker.lastStderrAt,
        });
        tracker.interactivePromptWarningEmitted = true;
        this.emit('process:interactive-prompt', {
          instanceId,
          state: tracker.instanceState,
          stdoutSilentMs: elapsed,
          lastStderrMs: now - tracker.lastStderrAt,
        });
      }
    }
  }
}
