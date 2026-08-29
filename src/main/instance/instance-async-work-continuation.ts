import type { Instance } from '../../shared/types/instance.types';
import type {
  InstanceAsyncWorkRegistry,
  InstanceAsyncWorkTerminalEvent,
} from './instance-async-work-registry';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getInstanceAsyncWorkRegistry } from './instance-async-work-registry';

const logger = getLogger('InstanceAsyncWorkContinuation');
const SETTLEMENT_TIMEOUT_MS = 60_000;

export const ASYNC_WORK_CONTINUATION_PROMPT =
  'A background task has finished. Review its task notification and result, then continue the work you were waiting to complete.';

export interface InstanceAsyncWorkContinuationHost {
  getInstance(instanceId: string): Pick<Instance, 'status' | 'requestCount'> | undefined;
  waitForInstanceSettled(instanceId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: { autoContinuation?: boolean },
  ): Promise<void>;
}

export class InstanceAsyncWorkContinuation {
  private readonly pendingRequestCounts = new Map<string, number>();
  private started = false;

  private readonly onTerminal = (notification: InstanceAsyncWorkTerminalEvent): void => {
    const { instanceId } = notification;
    if (this.pendingRequestCounts.has(instanceId)) {
      return;
    }

    const instance = this.host.getInstance(instanceId);
    if (!instance) {
      this.registry.finishCompletionDelivery(instanceId);
      return;
    }

    this.pendingRequestCounts.set(instanceId, instance.requestCount);
    queueMicrotask(() => {
      void this.deliver(notification).catch((error: unknown) => {
        logger.warn('Background-result continuation failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  };

  constructor(
    private readonly registry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceAsyncWorkContinuationHost,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registry.on('work:terminal', this.onTerminal);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.registry.off('work:terminal', this.onTerminal);
    for (const instanceId of this.pendingRequestCounts.keys()) {
      this.registry.finishCompletionDelivery(instanceId);
    }
    this.pendingRequestCounts.clear();
  }

  protected async deliver(notification: InstanceAsyncWorkTerminalEvent): Promise<void> {
    const { instanceId } = notification;
    const requestCountAtCompletion = this.pendingRequestCounts.get(instanceId);
    if (requestCountAtCompletion === undefined) return;

    try {
      const instanceAtCompletion = this.host.getInstance(instanceId);
      const alreadyReady = instanceAtCompletion?.status === 'idle'
        || instanceAtCompletion?.status === 'ready'
        || instanceAtCompletion?.status === 'hibernated';
      if (!alreadyReady) {
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
      if (!instance || instance.requestCount !== requestCountAtCompletion) {
        logger.info('Background-result continuation suppressed by a newer turn', {
          instanceId,
          requestCountAtCompletion,
          currentRequestCount: instance?.requestCount,
        });
        return;
      }

      if (
        instance.status !== 'idle'
        && instance.status !== 'ready'
        && instance.status !== 'hibernated'
      ) {
        logger.info('Background-result continuation suppressed because the instance is unavailable', {
          instanceId,
          status: instance.status,
        });
        return;
      }

      await this.host.sendInput(
        instanceId,
        ASYNC_WORK_CONTINUATION_PROMPT,
        undefined,
        { autoContinuation: true },
      );
    } finally {
      this.pendingRequestCounts.delete(instanceId);
      this.registry.finishCompletionDelivery(instanceId);
    }
  }
}

let activeContinuation: InstanceAsyncWorkContinuation | null = null;

export function initializeInstanceAsyncWorkContinuation(
  host: InstanceAsyncWorkContinuationHost,
): InstanceAsyncWorkContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceAsyncWorkContinuation(getInstanceAsyncWorkRegistry(), host);
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
