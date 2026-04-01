import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('StuckProcessDetector');

const CHECK_INTERVAL_MS = 10_000;

interface TimeoutConfig {
  softMs: number;
  hardMs: number;
}

const TIMEOUTS: Record<string, TimeoutConfig> = {
  generating: { softMs: 120_000, hardMs: 240_000 },
  tool_executing: { softMs: 600_000, hardMs: 1_200_000 },
};

/**
 * When the CLI process is confirmed alive (e.g. running Agent subagents),
 * multiply timeouts by this factor before emitting stuck events.
 * This prevents killing instances that are actively working but not
 * producing visible output (long-running tool chains, subagent spawns).
 */
const ALIVE_PROCESS_TIMEOUT_MULTIPLIER = 2;

/**
 * Maximum number of times we defer a timeout for a still-alive process.
 * Prevents infinite deferral for a truly stuck-but-alive process.
 */
const MAX_ALIVE_DEFERRALS = 3;

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
}

export class StuckProcessDetector extends EventEmitter {
  private trackers = new Map<string, ProcessTracker>();
  private checkInterval: NodeJS.Timeout | null = null;
  private isProcessAlive: ((instanceId: string) => boolean) | undefined;

  constructor(options?: StuckDetectorOptions) {
    super();
    this.isProcessAlive = options?.isProcessAlive;
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
    });
  }

  stopTracking(instanceId: string): void {
    this.trackers.delete(instanceId);
  }

  recordOutput(instanceId: string): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.lastOutputAt = Date.now();
      tracker.softWarningEmitted = false;
      tracker.interactivePromptWarningEmitted = false;
    }
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

    for (const [instanceId, tracker] of this.trackers) {
      if (tracker.instanceState === 'idle') continue;

      const config = TIMEOUTS[tracker.instanceState];
      if (!config) continue;

      const elapsed = now - tracker.lastOutputAt;

      // If the CLI process is still alive (e.g. running Agent subagents,
      // long bash commands), extend the hard kill threshold to avoid
      // terminating active work. Soft warnings use the base threshold
      // but are deferred while the process is alive (up to a cap).
      const processAlive = this.isProcessAlive?.(instanceId) ?? false;
      const hardMultiplier = processAlive ? ALIVE_PROCESS_TIMEOUT_MULTIPLIER : 1;
      const effectiveHardMs = config.hardMs * hardMultiplier;

      if (elapsed >= effectiveHardMs) {
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
      } else if (elapsed >= config.softMs && !tracker.softWarningEmitted) {
        // If process is alive and we haven't exhausted deferrals, defer
        // instead of warning — the instance is actively working.
        if (processAlive && tracker.aliveDeferrals < MAX_ALIVE_DEFERRALS) {
          tracker.aliveDeferrals++;
          logger.info('Process alive — deferring stuck warning', {
            instanceId,
            state: tracker.instanceState,
            elapsedMs: elapsed,
            deferral: tracker.aliveDeferrals,
            maxDeferrals: MAX_ALIVE_DEFERRALS,
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
