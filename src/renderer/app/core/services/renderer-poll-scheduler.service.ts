import { Injectable, OnDestroy } from '@angular/core';

type PollTask = () => void | Promise<void>;

interface ScheduledPollTask {
  callback: PollTask;
  intervalMs: number;
  nextRunAt: number;
  running: boolean;
}

const SCHEDULER_TICK_MS = 1_000;

@Injectable({ providedIn: 'root' })
export class RendererPollSchedulerService implements OnDestroy {
  private readonly tasks = new Map<number, ScheduledPollTask>();
  private nextTaskId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  register(callback: PollTask, intervalMs: number): () => void {
    const normalizedInterval = Math.max(SCHEDULER_TICK_MS, Math.floor(intervalMs));
    const taskId = this.nextTaskId++;
    this.tasks.set(taskId, {
      callback,
      intervalMs: normalizedInterval,
      nextRunAt: Date.now() + normalizedInterval,
      running: false,
    });
    this.ensureTimer();

    return () => {
      this.tasks.delete(taskId);
      if (this.tasks.size === 0) {
        this.stopTimer();
      }
    };
  }

  ngOnDestroy(): void {
    this.tasks.clear();
    this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.runDueTasks(), SCHEDULER_TICK_MS);
  }

  private runDueTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.running || task.nextRunAt > now) continue;
      task.nextRunAt = now + task.intervalMs;
      task.running = true;
      Promise.resolve()
        .then(() => task.callback())
        .catch(() => undefined)
        .finally(() => { task.running = false; });
    }
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
