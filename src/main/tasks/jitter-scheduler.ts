// src/main/tasks/jitter-scheduler.ts
/**
 * Jitter Scheduler
 *
 * Replaces raw setInterval patterns across the codebase with a centralized
 * scheduler that adds randomized jitter to prevent thundering herds when
 * multiple periodic tasks fire simultaneously.
 *
 * Existing setInterval patterns to migrate:
 *   - Session auto-save:     60s in session-continuity.ts
 *   - Hibernation check:     60s in hibernation-manager.ts
 *   - Pool warmup:           30s in pool-manager.ts
 *   - Stuck process check:   10s in stuck-process-detector.ts
 *   - Main process monitor:   1s in index.ts
 *
 * Suspend awareness: integrates with Electron powerMonitor 'resume' event
 * to detect missed executions after laptop lid-close/VM pause.
 */

import { powerMonitor } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('JitterScheduler');

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ScheduledTask {
  id?: string;
  name: string;
  intervalMs: number;
  handler: () => void | Promise<void>;
  /** Adds 0–N% random delay on top of intervalMs. Default: 10. */
  jitterPercent?: number;
  /** Shift by 3s if firing within 2s of a :00 minute boundary. Default: true. */
  avoidMinuteBoundary?: boolean;
  /** Max missed executions to catch up on after resume. Default: 3. */
  maxCatchUp?: number;
  /** Whether to immediately start scheduling. Default: true. */
  enabled?: boolean;
}

type MissedCallback = (taskId: string, missedCount: number) => void;

// ── Internal state ────────────────────────────────────────────────────────────

interface TaskState {
  task: Required<ScheduledTask>;
  timer: ReturnType<typeof setTimeout> | null;
  lastExecution: number;
  paused: boolean;
}

// ── Jitter algorithm ──────────────────────────────────────────────────────────

function nextTickMs(intervalMs: number, jitterPercent: number, avoidMinuteBoundary: boolean): number {
  const jitter = Math.random() * intervalMs * (jitterPercent / 100);
  let next = intervalMs + jitter;
  if (avoidMinuteBoundary) {
    const nextAbsolute = Date.now() + next;
    const secondsInMinute = (nextAbsolute / 1000) % 60;
    if (secondsInMinute < 2 || secondsInMinute > 58) {
      next += 3000;
    }
  }
  return next;
}

// ── Implementation ────────────────────────────────────────────────────────────

let taskCounter = 0;

export class JitterScheduler {
  private static instance: JitterScheduler;
  private tasks = new Map<string, TaskState>();
  private missedCallback: MissedCallback | null = null;

  private constructor() {
    this.setupPowerMonitor();
  }

  static getInstance(): JitterScheduler {
    if (!this.instance) {
      this.instance = new JitterScheduler();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.shutdown();
      try {
        powerMonitor.off('resume', (this.instance as unknown as { _resumeHandler: () => void })._resumeHandler);
      } catch {
        // Best effort — powerMonitor may be mocked
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).instance = undefined;
  }

  private setupPowerMonitor(): void {
    const resumeHandler = () => this.handleSystemResume();
    (this as unknown as { _resumeHandler: () => void })._resumeHandler = resumeHandler;
    try {
      powerMonitor.on('resume', resumeHandler);
    } catch {
      // powerMonitor may not be available in test environments
    }
  }

  private handleSystemResume(): void {
    logger.info('System resume detected — checking for missed tasks');
    const now = Date.now();

    for (const [id, state] of this.tasks) {
      if (state.paused) continue;

      const elapsed = now - state.lastExecution;
      const missedCount = Math.floor(elapsed / state.task.intervalMs) - 1;

      if (missedCount > 0) {
        const catchUpCount = Math.min(missedCount, state.task.maxCatchUp);
        logger.warn('Missed task executions detected after resume', {
          taskId: id,
          missedCount,
          catchUpCount,
        });

        this.missedCallback?.(id, missedCount);

        for (let i = 0; i < catchUpCount; i++) {
          this.runHandler(id, state);
        }
      }
    }
  }

  /** Schedule a task. Returns the task ID. */
  schedule(task: ScheduledTask): string {
    const id = task.id ?? `task-${++taskCounter}`;

    const normalized: Required<ScheduledTask> = {
      id,
      name: task.name,
      intervalMs: task.intervalMs,
      handler: task.handler,
      jitterPercent: task.jitterPercent ?? 10,
      avoidMinuteBoundary: task.avoidMinuteBoundary ?? true,
      maxCatchUp: task.maxCatchUp ?? 3,
      enabled: task.enabled ?? true,
    };

    const state: TaskState = {
      task: normalized,
      timer: null,
      lastExecution: Date.now(),
      paused: !normalized.enabled,
    };

    this.tasks.set(id, state);

    if (normalized.enabled) {
      this.scheduleNext(id, state);
    }

    return id;
  }

  private scheduleNext(id: string, state: TaskState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }

    const delayMs = nextTickMs(
      state.task.intervalMs,
      state.task.jitterPercent,
      state.task.avoidMinuteBoundary,
    );

    state.timer = setTimeout(() => {
      this.runHandler(id, state);
    }, delayMs);
  }

  private runHandler(id: string, state: TaskState): void {
    if (!this.tasks.has(id) || state.paused) return;

    state.lastExecution = Date.now();

    try {
      const result = state.task.handler();
      if (result instanceof Promise) {
        result.catch((err) => {
          logger.error('Scheduled task handler threw', err instanceof Error ? err : undefined, {
            taskId: id,
            taskName: state.task.name,
          });
        });
      }
    } catch (err) {
      logger.error('Scheduled task handler threw synchronously', err instanceof Error ? err : undefined, {
        taskId: id,
        taskName: state.task.name,
      });
    }

    // Re-schedule next execution (only if still registered)
    if (this.tasks.has(id) && !state.paused) {
      this.scheduleNext(id, state);
    }
  }

  /** Remove a task and clear its timer. */
  unschedule(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    this.tasks.delete(id);
  }

  /** Pause a task — timer is cleared but task remains registered. */
  pause(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    state.paused = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /** Resume a paused task — reschedules for next tick. */
  resume(id: string): void {
    const state = this.tasks.get(id);
    if (!state) return;

    state.paused = false;
    this.scheduleNext(id, state);
  }

  /** Register a callback for missed-task notifications. */
  onMissed(cb: MissedCallback): void {
    this.missedCallback = cb;
  }

  /** Clear all tasks and timers. */
  shutdown(): void {
    for (const [, state] of this.tasks) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.tasks.clear();
  }
}

export function getJitterScheduler(): JitterScheduler {
  return JitterScheduler.getInstance();
}
