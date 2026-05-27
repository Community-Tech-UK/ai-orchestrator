import type { EventEmitter } from 'events';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import {
  INSTANCE_SETTLED_DEBOUNCE_MS,
  findLatestSettlingOutput,
  isInstanceSettled,
} from './instance-state-machine';

export interface InstanceSettledEvent {
  instanceId: string;
  status: InstanceStatus;
  timestamp: number;
  instance: Instance;
  outputMessageId?: string;
  outputTimestamp?: number;
}

export interface InstanceSettledWaitOptions {
  afterTimestamp?: number;
  timeoutMs?: number;
  debounceMs?: number;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  onProgress?: (elapsedMs: number) => void;
  progressIntervalMs?: number;
}

export interface InstanceSettledTrackerDeps {
  getInstance: (id: string) => Instance | undefined;
  emitter: Pick<EventEmitter, 'emit' | 'on' | 'off'>;
  debounceMs?: number;
}

export class InstanceSettledTracker {
  private readonly settledTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settledLastEventAt = new Map<string, number>();
  private readonly settledLastEmittedKey = new Map<string, string>();

  constructor(private readonly deps: InstanceSettledTrackerDeps) {}

  recordActivity(instanceId: string, timestamp = Date.now()): void {
    this.settledLastEventAt.set(instanceId, timestamp);
    const existing = this.settledTimers.get(instanceId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.settledTimers.delete(instanceId);
      this.maybeEmit(instanceId);
    }, this.deps.debounceMs ?? INSTANCE_SETTLED_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.settledTimers.set(instanceId, timer);
  }

  maybeEmit(instanceId: string): void {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.clear(instanceId);
      return;
    }

    const lastEventAt = this.settledLastEventAt.get(instanceId) ?? instance.lastActivity ?? instance.createdAt;
    const now = Date.now();
    if (!isInstanceSettled({
      status: instance.status,
      outputBuffer: instance.outputBuffer,
      activeTurnId: instance.activeTurnId,
      interruptRequestId: instance.interruptRequestId,
      interruptPhase: instance.interruptPhase,
      lastEventAt,
      now,
      debounceMs: this.deps.debounceMs ?? INSTANCE_SETTLED_DEBOUNCE_MS,
    })) {
      return;
    }

    const output = findLatestSettlingOutput(instance.outputBuffer);
    const emittedKey = `${instance.status}:${output?.id ?? 'none'}:${output?.timestamp ?? 0}:${instance.outputBuffer.length}`;
    if (this.settledLastEmittedKey.get(instanceId) === emittedKey) {
      return;
    }
    this.settledLastEmittedKey.set(instanceId, emittedKey);

    this.deps.emitter.emit('instance:settled', {
      instanceId,
      status: instance.status,
      timestamp: now,
      instance,
      outputMessageId: output?.id,
      outputTimestamp: output?.timestamp,
    } satisfies InstanceSettledEvent);
  }

  clear(instanceId: string): void {
    const timer = this.settledTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
    }
    this.settledTimers.delete(instanceId);
    this.settledLastEventAt.delete(instanceId);
    this.settledLastEmittedKey.delete(instanceId);
  }

  async waitForSettled(
    instanceId: string,
    options: InstanceSettledWaitOptions = {},
  ): Promise<Instance | undefined> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    const debounceMs = options.debounceMs ?? this.deps.debounceMs ?? INSTANCE_SETTLED_DEBOUNCE_MS;
    const getSettledInstance = (): Instance | undefined => {
      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        return undefined;
      }

      const lastEventAt = this.settledLastEventAt.get(instanceId) ?? 0;
      return isInstanceSettled({
        status: instance.status,
        outputBuffer: instance.outputBuffer,
        activeTurnId: instance.activeTurnId,
        interruptRequestId: instance.interruptRequestId,
        interruptPhase: instance.interruptPhase,
        afterTimestamp: options.afterTimestamp,
        lastEventAt,
        now: Date.now(),
        debounceMs,
      })
        ? instance
        : undefined;
    };

    const existing = getSettledInstance();
    if (existing) {
      return existing;
    }

    return new Promise<Instance | undefined>((resolve, reject) => {
      let completed = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let progressTimer: ReturnType<typeof setInterval> | undefined;

      const cleanup = (): void => {
        this.deps.emitter.off('instance:settled', handleSettled);
        this.deps.emitter.off('instance:removed', handleRemoved);
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (progressTimer) {
          clearInterval(progressTimer);
        }
      };

      const finish = (instance: Instance | undefined): void => {
        if (completed) {
          return;
        }
        completed = true;
        cleanup();
        resolve(instance);
      };

      const fail = (error: Error): void => {
        if (completed) {
          return;
        }
        completed = true;
        cleanup();
        reject(error);
      };

      const isCancelled = (): boolean => (
        options.signal?.aborted === true
        || options.isCancelled?.() === true
      );

      const handleSettled = (event: InstanceSettledEvent): void => {
        if (event.instanceId !== instanceId) {
          return;
        }
        const settled = getSettledInstance();
        if (settled) {
          finish(settled);
        }
      };

      const handleRemoved = (removedInstanceId: string): void => {
        if (removedInstanceId === instanceId) {
          finish(undefined);
        }
      };

      if (isCancelled()) {
        finish(this.deps.getInstance(instanceId));
        return;
      }

      this.deps.emitter.on('instance:settled', handleSettled);
      this.deps.emitter.on('instance:removed', handleRemoved);

      timeoutTimer = setTimeout(() => {
        fail(new Error(`Timed out waiting for instance ${instanceId} to settle`));
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') {
        timeoutTimer.unref();
      }

      progressTimer = setInterval(() => {
        if (isCancelled()) {
          finish(this.deps.getInstance(instanceId));
          return;
        }
        options.onProgress?.(Date.now() - startedAt);
      }, options.progressIntervalMs ?? 1000);
      if (typeof progressTimer.unref === 'function') {
        progressTimer.unref();
      }
    });
  }

  destroy(): void {
    for (const timer of this.settledTimers.values()) {
      clearTimeout(timer);
    }
    this.settledTimers.clear();
    this.settledLastEventAt.clear();
    this.settledLastEmittedKey.clear();
  }
}
