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

export type ProcessState = 'generating' | 'tool_executing' | 'idle';

interface ProcessTracker {
  lastOutputAt: number;
  instanceState: ProcessState;
  softWarningEmitted: boolean;
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
    }
  }

  updateState(instanceId: string, state: ProcessState): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.instanceState = state;
      tracker.lastOutputAt = Date.now();
      tracker.softWarningEmitted = false;
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
    }
  }
}
