import type { Instance } from '../../shared/types/instance.types';
import type {
  InstanceAsyncWorkProviderResumedEvent,
  InstanceAsyncWorkRegistry,
  InstanceAsyncWorkTerminalEvent,
} from './instance-async-work-registry';
import { InstanceContinuationDispatch, type ContinuationReservation, type InstanceContinuationDispatchHost } from './instance-continuation-dispatch';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getInstanceAsyncWorkRegistry } from './instance-async-work-registry';

const logger = getLogger('InstanceAsyncWorkContinuation');
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

export interface InstanceAsyncWorkContinuationHost extends InstanceContinuationDispatchHost {
  getInstance(instanceId: string): Pick<Instance, 'status' | 'requestCount' | 'lastActivity'> | undefined;
}

export interface InstanceAsyncWorkContinuationOptions {
  providerResumeGraceMs?: number;
  dispatch?: InstanceContinuationDispatch;
  isPaused?: () => boolean;
  isManagedLoopInstance?: (instanceId: string) => boolean;
}

interface PendingDelivery {
  reservation?: ContinuationReservation;
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

    const delivery: PendingDelivery = { providerResumed: false };
    this.pending.set(instanceId, delivery);
    delivery.reservation = this.dispatch.reserve({
      instanceId, trigger: 'async-result', requestCount: instance.requestCount,
      prompt: ASYNC_WORK_CONTINUATION_PROMPT, internalSource: 'async-work-continuation',
      isCurrent: () => this.started && this.pending.get(instanceId) === delivery && !delivery.providerResumed,
    });
    if (!delivery.reservation) {
      this.pending.delete(instanceId);
      this.registry.finishCompletionDelivery(instanceId);
      return;
    }
    queueMicrotask(() => {
      void this.deliver(instanceId, instance.status === 'hibernated').catch(() => {
        logger.warn('Background-result continuation failed', { instanceId });
      });
    });
  };

  private readonly onProviderResumed = ({ instanceId }: InstanceAsyncWorkProviderResumedEvent): void => {
    const delivery = this.pending.get(instanceId);
    if (!delivery) return;
    delivery.providerResumed = true;
    this.dispatch.cancel(delivery.reservation);
    delivery.wakeGrace?.();
  };

  private readonly providerResumeGraceMs: number;
  private readonly dispatch: InstanceContinuationDispatch;
  private readonly ownsDispatch: boolean;

  constructor(
    private readonly registry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceAsyncWorkContinuationHost,
    options: InstanceAsyncWorkContinuationOptions = {},
  ) {
    this.providerResumeGraceMs = options.providerResumeGraceMs ?? PROVIDER_RESUME_GRACE_MS;
    this.ownsDispatch = options.dispatch === undefined;
    this.dispatch = options.dispatch ?? new InstanceContinuationDispatch(registry, host,
      options.isManagedLoopInstance, options.isPaused);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.ownsDispatch) this.dispatch.start();
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
    if (this.ownsDispatch) this.dispatch.stop();
    this.registry.off('work:terminal', this.onTerminal);
    this.registry.off('work:provider-resumed', this.onProviderResumed);
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [instanceId, delivery] of this.pending) {
      this.dispatch.cancel(delivery.reservation);
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
      ) {
        continue;
      }

      const reservation = this.dispatch.reserve({
        instanceId, trigger: 'async-check-in', requestCount: instance.requestCount,
        prompt: buildStalledWorkCheckInPrompt(now - instance.lastActivity), internalSource: 'async-work-continuation',
        isCurrent: () => this.started && this.registry.activeWorkIds(instanceId).join(',') === signature,
      });
      if (!reservation) continue;
      this.checkedInWork.set(instanceId, signature);
      logger.info('Checking in on stalled background work', { instanceId, backgroundTasks: summary.count });
      try {
        await this.dispatch.dispatch(reservation, { settle: false });
      } catch {
        logger.warn('Stalled background work check-in failed', { instanceId });
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

      const instance = this.host.getInstance(instanceId);
      if (!delivery.reservation) return;
      await this.dispatch.dispatch(delivery.reservation, {
        settle: !instance || !READY_FOR_AUTOMATIC_INPUT.has(instance.status),
      });
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
        delivery.reservation?.abortController.signal.removeEventListener('abort', done);
        resolve();
      }
      delivery.wakeGrace = done;
      const signal = delivery.reservation?.abortController.signal;
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
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
