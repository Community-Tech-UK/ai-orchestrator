import type { Instance } from '../../shared/types/instance.types';
import type {
  InstanceAsyncWorkProviderResumedEvent,
  InstanceAsyncWorkRegistry,
  InstanceAsyncWorkTerminalEvent,
} from './instance-async-work-registry';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getInstanceAsyncWorkRegistry } from './instance-async-work-registry';

const logger = getLogger('InstanceAsyncWorkContinuation');
const SETTLEMENT_TIMEOUT_MS = 60_000;
/**
 * Claude CLI starts its own turn within about a second of a task notification
 * that arrives between turns. Waiting this long before the fallback continuation
 * avoids a second, duplicate turn.
 */
const PROVIDER_RESUME_GRACE_MS = 15_000;
/** An idle session silent this long while it still owns background work gets one check-in. */
export const STALLED_WORK_CHECK_IN_AFTER_MS = 10 * 60_000;
const STALLED_WORK_SWEEP_INTERVAL_MS = 60_000;
const READY_FOR_AUTOMATIC_INPUT = new Set<Instance['status']>(['idle', 'ready', 'hibernated']);

export const ASYNC_WORK_CONTINUATION_PROMPT =
  'A background task has finished. Review its task notification and result, then continue the work you were waiting to complete.';

export function buildStalledWorkCheckInPrompt(silentForMs: number): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  return [
    `Automatic check-in: background work you started is still running, and this session has been silent for ${minutes} minutes.`,
    'Check its output now.',
    'If it is still making progress, say so in one sentence and keep waiting.',
    'If it is stuck or waiting on something that will not happen, stop it and complete the work another way.',
  ].join(' ');
}

export interface InstanceAsyncWorkContinuationHost {
  getInstance(instanceId: string): Pick<Instance, 'status' | 'requestCount' | 'lastActivity'> | undefined;
  waitForInstanceSettled(instanceId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: { autoContinuation?: boolean },
  ): Promise<void>;
}

export interface InstanceAsyncWorkContinuationOptions {
  providerResumeGraceMs?: number;
  isPaused?: () => boolean;
  isManagedLoopInstance?: (instanceId: string) => boolean;
}

interface PendingDelivery {
  requestCount: number;
  providerResumed: boolean;
  wakeGrace?: () => void;
}

export class InstanceAsyncWorkContinuation {
  private readonly pending = new Map<string, PendingDelivery>();
  /** Work-set signature each instance was last checked in about, so a check-in never repeats. */
  private readonly checkedInWork = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private readonly onTerminal = (notification: InstanceAsyncWorkTerminalEvent): void => {
    const { instanceId } = notification;
    if (this.pending.has(instanceId)) {
      return;
    }

    const instance = this.host.getInstance(instanceId);
    if (!instance || !READY_FOR_AUTOMATIC_INPUT.has(instance.status)) {
      // Mid-turn, Claude CLI owns delivery: it feeds the notification into the
      // running turn, drops it when the model already read that task's output,
      // or starts its own turn afterwards (probed live and in local transcripts
      // on 2026-09-17). A continuation from here would duplicate all three.
      this.registry.finishCompletionDelivery(instanceId);
      return;
    }

    this.pending.set(instanceId, { requestCount: instance.requestCount, providerResumed: false });
    queueMicrotask(() => {
      void this.deliver(instanceId, instance.status === 'hibernated').catch((error: unknown) => {
        logger.warn('Background-result continuation failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  };

  private readonly onProviderResumed = ({ instanceId }: InstanceAsyncWorkProviderResumedEvent): void => {
    const delivery = this.pending.get(instanceId);
    if (!delivery) return;
    delivery.providerResumed = true;
    delivery.wakeGrace?.();
  };

  private readonly providerResumeGraceMs: number;
  private readonly isPaused: () => boolean;
  private readonly isManagedLoopInstance: (instanceId: string) => boolean;

  constructor(
    private readonly registry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceAsyncWorkContinuationHost,
    options: InstanceAsyncWorkContinuationOptions = {},
  ) {
    this.providerResumeGraceMs = options.providerResumeGraceMs ?? PROVIDER_RESUME_GRACE_MS;
    this.isPaused = options.isPaused ?? (() => false);
    this.isManagedLoopInstance = options.isManagedLoopInstance ?? (() => false);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registry.on('work:terminal', this.onTerminal);
    this.registry.on('work:provider-resumed', this.onProviderResumed);
    this.sweepTimer = setInterval(() => {
      void this.checkStalledWork(Date.now());
    }, STALLED_WORK_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.registry.off('work:terminal', this.onTerminal);
    this.registry.off('work:provider-resumed', this.onProviderResumed);
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [instanceId, delivery] of this.pending) {
      delivery.wakeGrace?.();
      this.registry.finishCompletionDelivery(instanceId);
    }
    this.pending.clear();
    this.checkedInWork.clear();
  }

  /**
   * One check-in per distinct set of background work for an idle session that
   * has produced nothing for {@link STALLED_WORK_CHECK_IN_AFTER_MS}. A hung job
   * never sends a completion, so without this the session waits forever.
   */
  async checkStalledWork(now: number): Promise<void> {
    for (const instanceId of this.registry.instancesWithActiveWork()) {
      const summary = this.registry.backgroundWorkSummary(instanceId);
      const instance = this.host.getInstance(instanceId);
      const signature = this.registry.activeWorkIds(instanceId).join(',');
      if (
        !summary
        || !instance
        || (instance.status !== 'idle' && instance.status !== 'ready')
        || this.pending.has(instanceId)
        || this.checkedInWork.get(instanceId) === signature
        || now - summary.since < STALLED_WORK_CHECK_IN_AFTER_MS
        || now - instance.lastActivity < STALLED_WORK_CHECK_IN_AFTER_MS
        || this.automaticInputBlocked(instanceId)
      ) {
        continue;
      }

      this.checkedInWork.set(instanceId, signature);
      const silentForMs = now - instance.lastActivity;
      logger.info('Checking in on stalled background work', {
        instanceId,
        backgroundTasks: summary.count,
        silentForMs,
      });
      try {
        await this.host.sendInput(
          instanceId,
          buildStalledWorkCheckInPrompt(silentForMs),
          undefined,
          { autoContinuation: true },
        );
      } catch (error: unknown) {
        logger.warn('Stalled background work check-in failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  protected async deliver(instanceId: string, hibernated: boolean): Promise<void> {
    const delivery = this.pending.get(instanceId);
    if (!delivery) return;

    try {
      if (!hibernated) {
        await this.waitForProviderResumeGrace(delivery);
      }
      if (!this.started || this.pending.get(instanceId) !== delivery) {
        return;
      }
      if (delivery.providerResumed) {
        logger.info('Background-result continuation not needed; the provider resumed on its own', { instanceId });
        return;
      }

      const instanceAtCompletion = this.host.getInstance(instanceId);
      if (!instanceAtCompletion || !READY_FOR_AUTOMATIC_INPUT.has(instanceAtCompletion.status)) {
        try {
          await this.host.waitForInstanceSettled(instanceId, { timeoutMs: SETTLEMENT_TIMEOUT_MS });
        } catch (error: unknown) {
          logger.warn('Background-result continuation timed out waiting for settlement', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      const instance = this.host.getInstance(instanceId);
      if (!instance || instance.requestCount !== delivery.requestCount || delivery.providerResumed) {
        logger.info('Background-result continuation suppressed by a newer turn', {
          instanceId,
          requestCountAtCompletion: delivery.requestCount,
          currentRequestCount: instance?.requestCount,
        });
        return;
      }

      if (!READY_FOR_AUTOMATIC_INPUT.has(instance.status)) {
        logger.info('Background-result continuation suppressed because the instance is unavailable', {
          instanceId,
          status: instance.status,
        });
        return;
      }

      if (this.automaticInputBlocked(instanceId)) {
        logger.info('Background-result continuation held: app paused or session owned by a loop', { instanceId });
        return;
      }

      await this.host.sendInput(
        instanceId,
        ASYNC_WORK_CONTINUATION_PROMPT,
        undefined,
        { autoContinuation: true },
      );
    } finally {
      if (this.pending.get(instanceId) === delivery) {
        this.pending.delete(instanceId);
      }
      this.registry.finishCompletionDelivery(instanceId);
    }
  }

  private waitForProviderResumeGrace(delivery: PendingDelivery): Promise<void> {
    if (delivery.providerResumed || this.providerResumeGraceMs <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.providerResumeGraceMs);
      function done(): void {
        clearTimeout(timer);
        delivery.wakeGrace = undefined;
        resolve();
      }
      delivery.wakeGrace = done;
    });
  }

  private automaticInputBlocked(instanceId: string): boolean {
    try {
      return this.isPaused() || this.isManagedLoopInstance(instanceId);
    } catch (error: unknown) {
      logger.warn('Could not establish pause or loop ownership; holding automatic check-in', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}

let activeContinuation: InstanceAsyncWorkContinuation | null = null;

export function initializeInstanceAsyncWorkContinuation(
  host: InstanceAsyncWorkContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceAsyncWorkContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceAsyncWorkContinuation(getInstanceAsyncWorkRegistry(), host, {
    isManagedLoopInstance,
    isPaused,
  });
  activeContinuation.start();
  registerCleanup(() => {
    activeContinuation?.stop();
    activeContinuation = null;
  });
  return activeContinuation;
}

export function _disposeInstanceAsyncWorkContinuationForTesting(): void {
  activeContinuation?.stop();
  activeContinuation = null;
}
