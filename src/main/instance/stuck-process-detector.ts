import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('StuckProcessDetector');

const CHECK_INTERVAL_MS = 10_000;

interface TimeoutConfig {
  softMs: number;
  hardMs: number;
}

const TIMEOUTS: Record<string, TimeoutConfig> = {
  generating: { softMs: 120_000, hardMs: 240_000 },
  tool_executing: { softMs: 300_000, hardMs: 600_000 },
};

/**
 * Timeout for detecting when a subprocess is waiting for interactive input
 * it will never receive (e.g., `npm init` without `-y`, `git rebase -i`).
 * Shorter than other timeouts since interactive prompts happen quickly.
 * Inspired by Claude Code 2.1.84 background task interactive-prompt detection.
 */
const INTERACTIVE_PROMPT_DETECT_MS = 45_000;

export type ProcessState = 'generating' | 'tool_executing' | 'idle';

interface ProcessTracker {
  lastOutputAt: number;
  instanceState: ProcessState;
  softWarningEmitted: boolean;
  /** Whether stdout has gone silent while stderr/process is alive (interactive prompt indicator) */
  interactivePromptWarningEmitted: boolean;
  /** Last time we saw stderr output (interactive prompts often write to stderr) */
  lastStderrAt: number;
}

export class StuckProcessDetector extends EventEmitter {
  private trackers = new Map<string, ProcessTracker>();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.checkInterval = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    if (this.checkInterval.unref) this.checkInterval.unref();
  }

  startTracking(instanceId: string): void {
    this.trackers.set(instanceId, {
      lastOutputAt: Date.now(),
      instanceState: 'idle',
      softWarningEmitted: false,
      interactivePromptWarningEmitted: false,
      lastStderrAt: 0,
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

      if (elapsed >= config.hardMs) {
        logger.warn('Process stuck — hard timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        this.emit('process:stuck', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        this.trackers.delete(instanceId);
      } else if (elapsed >= config.softMs && !tracker.softWarningEmitted) {
        logger.warn('Process may be stuck — soft timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
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
