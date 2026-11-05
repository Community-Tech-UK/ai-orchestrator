import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { AdapterCapabilities } from '../cli/adapters/base-cli-adapter.types';
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
// Do not shorten Claude stall timers below 5 minutes without reading CHANGELOG.md:4179.
export const STALLED_WORK_CHECK_IN_AFTER_MS = 10 * 60_000;
const STALLED_WORK_SWEEP_INTERVAL_MS = 60_000;
const READY_FOR_AUTOMATIC_INPUT = new Set<Instance['status']>(['idle', 'ready', 'hibernated']);
const COMPLETION_DETAIL_CHARS = 120;

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

interface AsyncWorkAdapter {
  getAdapterCapabilities?(): Pick<AdapterCapabilities, 'supportsAsyncWorkAutoResume'>;
}

/** A result that arrived mid-turn for a provider that cannot resume by itself. */
interface DeferredCompletion {
  notification: InstanceAsyncWorkTerminalEvent;
  adapter: AsyncWorkAdapter;
  /**
   * Idle can arrive before the turn's ending is processed, and that ending
   * revokes a queued continuation, so delivery waits for both.
   */
  turnEnded: boolean;
  /** A sweep has already found the session ready, so the next one may stop waiting. */
  sweptWhileReady: boolean;
  /** Results that arrived while waiting share the one wake, so its prompt names them all. */
  details: string[];
}

function sharedDetail(details: string[]): string | undefined {
  if (details.length === 0) return undefined;
  const share = Math.max(8, Math.floor(COMPLETION_DETAIL_CHARS / details.length) - 2);
  // Commands usually differ at the end: they share a leading `cd` to the project.
  return details.length === 1 ? details[0] : details.map((detail) => detail.slice(-share)).join('; ');
}

interface PendingDelivery {
  reservation?: ContinuationReservation;
  providerResumed: boolean;
  wakeGrace?: () => void;
}

export class InstanceAsyncWorkContinuation {
  private readonly pending = new Map<string, PendingDelivery>();
  private readonly busyCompletions = new Map<string, DeferredCompletion>();
  private readonly onInstanceState = ({ instanceId }: { instanceId: string }): void => {
    const deferred = this.busyCompletions.get(instanceId);
    if (!deferred) return;
    const instance = this.host.getInstance(instanceId);
    if (!instance || this.host.getAdapter?.(instanceId) !== deferred.adapter
      || ['terminated', 'failed', 'error', 'cancelled', 'superseded'].includes(instance.status)) {
      this.busyCompletions.delete(instanceId);
      this.registry.finishCompletionDelivery(instanceId);
      return;
    }
    // A wake still in flight re-checks this deferral when it finishes.
    if (!READY_FOR_AUTOMATIC_INPUT.has(instance.status) || !deferred.turnEnded || this.pending.has(instanceId)) return;
    this.busyCompletions.delete(instanceId);
    const { notification } = deferred;
    this.onTerminal({ instanceId, event: { ...notification.event, detail: sharedDetail(deferred.details) } });
  };
  private readonly onProviderEvent = ({ instanceId, event }: ProviderRuntimeEventEnvelope): void => {
    if (event.kind !== 'complete') return;
    const deferred = this.busyCompletions.get(instanceId);
    if (!deferred) return;
    const requestCount = event.requestCountAtCompletion;
    if (requestCount !== undefined && requestCount !== this.host.getInstance(instanceId)?.requestCount) return;
    deferred.turnEnded = true;
    this.onInstanceState({ instanceId });
  };
  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.busyCompletions.delete(instanceId);
    this.registry.finishCompletionDelivery(instanceId);
  };
  /** Work-set signature each instance was last checked in about, so a check-in never repeats. */
  private readonly checkedInWork = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private readonly onTerminal = (notification: InstanceAsyncWorkTerminalEvent): void => {
    const { instanceId } = notification;
    const instance = this.host.getInstance(instanceId);
    const adapter = this.host.getAdapter?.(instanceId) as AsyncWorkAdapter | undefined;
    const existing = this.busyCompletions.get(instanceId);
    // Checked before the in-flight wake below: that wake's own turn can end with a new unread result.
    const deferrable = adapter && instance && ['busy', 'processing', 'thinking_deeply'].includes(instance.status)
      && adapter.getAdapterCapabilities?.().supportsAsyncWorkAutoResume === false;
    const deferred = existing
      ?? (deferrable ? { notification, adapter, turnEnded: false, sweptWhileReady: false, details: [] } : undefined);
    if (deferred) {
      if (notification.event.detail) deferred.details.push(notification.event.detail);
      this.busyCompletions.set(instanceId, deferred);
      return;
    }
    if (this.pending.has(instanceId)) {
      return;
    }

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
      prompt: notification.event.detail
        ? `A background command you started has finished: \`${notification.event.detail.slice(0, COMPLETION_DETAIL_CHARS)}\`. Check its output, then continue the work you were waiting to complete.`
        : ASYNC_WORK_CONTINUATION_PROMPT, internalSource: 'async-work-continuation',
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
    this.host.on?.('instance:state-changed', this.onInstanceState);
    this.host.on?.('provider:normalized-event', this.onProviderEvent);
    this.host.on?.('instance:removed', this.onInstanceRemoved);
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
    this.host.off?.('instance:state-changed', this.onInstanceState);
    this.host.off?.('provider:normalized-event', this.onProviderEvent);
    this.host.off?.('instance:removed', this.onInstanceRemoved);
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
    for (const instanceId of this.busyCompletions.keys()) this.registry.finishCompletionDelivery(instanceId);
    this.busyCompletions.clear();
    this.checkedInWork.clear();
  }

  /**
   * One check-in per distinct set of background work for an idle session that
   * has produced nothing for {@link STALLED_WORK_CHECK_IN_AFTER_MS}. A hung job
   * never sends a completion, so without this the session waits forever.
   */
  async checkStalledWork(now: number): Promise<void> {
    for (const [instanceId, deferred] of this.busyCompletions) {
      // A stopped turn reports no ending. Two ready sweeps outlast any real delay in that report.
      const status = this.host.getInstance(instanceId)?.status;
      const ready = status !== undefined && READY_FOR_AUTOMATIC_INPUT.has(status);
      if (ready && deferred.sweptWhileReady) deferred.turnEnded = true;
      deferred.sweptWhileReady = ready;
      this.onInstanceState({ instanceId });
    }
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
      const adapter = this.host.getAdapter?.(instanceId) as AsyncWorkAdapter | undefined;
      if (!hibernated && adapter?.getAdapterCapabilities?.().supportsAsyncWorkAutoResume !== false) {
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
      if (this.busyCompletions.has(instanceId)) this.onInstanceState({ instanceId });
      else this.registry.finishCompletionDelivery(instanceId);
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
