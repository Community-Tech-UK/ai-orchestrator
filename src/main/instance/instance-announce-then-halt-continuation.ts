import type { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { detectTrailingAnnounceThenHalt } from '../orchestration/announce-then-halt-detector';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import {
  isRecoverableTransportCompletion,
  TRANSPORT_RECOVERY_DELAYS_MS,
  TRANSPORT_RECOVERY_PROMPT,
  waitForTransportRecovery,
} from './instance-transport-recovery-policy';
import {
  getInstanceAsyncWorkRegistry,
  type InstanceAsyncWorkRegistry,
} from './instance-async-work-registry';

const logger = getLogger('InstanceAnnounceThenHaltContinuation');
const SETTLEMENT_TIMEOUT_MS = 60_000;
const MAX_NUDGES_PER_USER_TURN_CHAIN = 1;
const READY_FOR_AUTOMATIC_INPUT = new Set<Instance['status']>([
  'idle',
  'ready',
  'hibernated',
]);
const TERMINAL_OR_UNAVAILABLE = new Set<Instance['status']>([
  'initializing',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'terminated',
  'failed',
  'error',
  'cancelled',
  'superseded',
  'respawning',
  'hibernating',
  'waking',
  'degraded',
]);

export const ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX =
  'Continue now. You ended the last turn by announcing the next action instead of executing it.';

interface ContinuationState {
  nudgeCount: number;
  transportRetryCount: number;
  suppressed?: boolean;
  lastHandledRequestCount?: number;
  pending?: ContinuationDelivery;
}

interface ContinuationDelivery {
  requestCount: number;
  transport: boolean;
  sessionId: string;
  adapterGeneration?: number;
  provider: Instance['provider'];
  prompt: string;
  abortController?: AbortController;
}

export interface InstanceAnnounceThenHaltContinuationHost {
  on: Pick<EventEmitter, 'on'>['on'];
  off: Pick<EventEmitter, 'off'>['off'];
  getInstance(instanceId: string): Instance | undefined;
  emitSystemMessage?(instanceId: string, content: string, metadata?: Record<string, unknown>): void;
  waitForInstanceSettled(
    instanceId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: {
      autoContinuation?: boolean;
      signal?: AbortSignal;
      beforeProviderDispatch?: () => void;
    },
  ): Promise<void>;
}

interface InstanceInputStartedEvent {
  instanceId: string;
  autoContinuation: boolean;
}

function readRawCompletionText(envelope: ProviderRuntimeEventEnvelope): string | null {
  const payload = envelope.raw?.payload;
  if (!payload || typeof payload !== 'object') return null;
  const content = (payload as Record<string, unknown>)['content'];
  return typeof content === 'string' && content.trim() ? content : null;
}

function readCompletionText(
  envelope: ProviderRuntimeEventEnvelope,
  instance: Instance,
): string | null {
  const rawContent = readRawCompletionText(envelope);
  if (rawContent) return rawContent;
  const latestMessage = latestConversationMessage(instance);
  return latestMessage?.type === 'assistant' && latestMessage.content.trim()
    ? latestMessage.content
    : null;
}

function latestConversationMessage(
  instance: Instance,
): Instance['outputBuffer'][number] | undefined {
  for (let index = instance.outputBuffer.length - 1; index >= 0; index -= 1) {
    const message = instance.outputBuffer[index];
    if (message?.type === 'assistant' || message?.type === 'user') return message;
  }
  return undefined;
}

function isEligibleRootSession(instance: Instance): boolean {
  return instance.parentId === null
    && instance.launchMode === 'orchestrated'
    && !TERMINAL_OR_UNAVAILABLE.has(instance.status)
    && instance.waitReason === undefined;
}

export class InstanceAnnounceThenHaltContinuation {
  private readonly states = new Map<string, ContinuationState>();
  private readonly manualTurnAssistantBaselines = new Map<string, string | undefined>();
  private started = false;

  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    if (envelope.event.kind !== 'complete') return;
    this.maybeSchedule(envelope);
  };

  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.states.get(instanceId)?.pending?.abortController?.abort();
    this.states.delete(instanceId);
    this.manualTurnAssistantBaselines.delete(instanceId);
  };

  private readonly onInterruptRequested = ({ instanceId }: { instanceId: string }): void => {
    const state = this.states.get(instanceId) ?? { nudgeCount: 0, transportRetryCount: 0 };
    state.pending?.abortController?.abort();
    state.suppressed = true;
    this.states.set(instanceId, state);
  };

  private readonly onStateChanged = (event: { instanceId: string; status: Instance['status'] }): void => {
    if (['interrupting', 'cancelling', 'interrupt-escalating', 'cancelled', 'terminated', 'superseded'].includes(event.status)) {
      this.onInterruptRequested(event);
    }
  };

  private readonly onInputStarted = (event: InstanceInputStartedEvent): void => {
    if (event.autoContinuation) return;
    this.states.get(event.instanceId)?.pending?.abortController?.abort();
    this.states.delete(event.instanceId);
    const instance = this.host.getInstance(event.instanceId);
    const latestMessage = instance ? latestConversationMessage(instance) : undefined;
    this.manualTurnAssistantBaselines.set(
      event.instanceId,
      latestMessage?.type === 'assistant' ? latestMessage.id : undefined,
    );
  };

  constructor(
    private readonly asyncWorkRegistry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceAnnounceThenHaltContinuationHost,
    private readonly isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    private readonly isPaused: () => boolean = () => false,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:removed', this.onInstanceRemoved);
    this.host.on('instance:input-started', this.onInputStarted);
    this.host.on('instance:interrupt-requested', this.onInterruptRequested);
    this.host.on('instance:state-changed', this.onStateChanged);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:removed', this.onInstanceRemoved);
    this.host.off('instance:input-started', this.onInputStarted);
    this.host.off('instance:interrupt-requested', this.onInterruptRequested);
    this.host.off('instance:state-changed', this.onStateChanged);
    for (const state of this.states.values()) {
      state.pending?.abortController?.abort();
    }
    this.states.clear();
    this.manualTurnAssistantBaselines.clear();
  }

  private maybeSchedule(envelope: ProviderRuntimeEventEnvelope): void {
    const { instanceId, event } = envelope;
    const instance = this.host.getInstance(instanceId);
    if (
      !instance
      || !isEligibleRootSession(instance)
      || event.kind !== 'complete'
      || event.degradedReason !== undefined
      || event.quota?.exhausted === true
      || event.rateLimit?.remaining === 0
      || this.isAutomaticInputPaused()
      || this.hasManagedLoopOwnership(instanceId)
      || this.asyncWorkRegistry.hasInhibitor(instanceId)
    ) {
      return;
    }

    if (latestConversationMessage(instance)?.type === 'user') return;
    const requestCountAtProviderCompletion = event.requestCountAtCompletion;
    if (
      requestCountAtProviderCompletion === undefined
      || requestCountAtProviderCompletion !== instance.requestCount
    ) {
      return;
    }

    if (this.manualTurnAssistantBaselines.has(instanceId)) {
      const latestMessage = latestConversationMessage(instance);
      const baselineAssistantId = this.manualTurnAssistantBaselines.get(instanceId);
      if (
        latestMessage?.type !== 'assistant'
        || latestMessage.id === baselineAssistantId
      ) {
        return;
      }
      const rawContent = readRawCompletionText(envelope);
      if (
        rawContent
        && rawContent.replace(/\s+/g, ' ').trim()
          !== latestMessage.content.replace(/\s+/g, ' ').trim()
      ) {
        return;
      }
      this.manualTurnAssistantBaselines.delete(instanceId);
    }

    let state = this.states.get(instanceId);
    if (!state) {
      state = {
        nudgeCount: 0,
        transportRetryCount: 0,
      };
      this.states.set(instanceId, state);
    }
    if (
      state.pending !== undefined
      || state.suppressed
      || state.lastHandledRequestCount === instance.requestCount
    ) {
      return;
    }

    const transport = isRecoverableTransportCompletion(envelope);
    const responseText = readCompletionText(envelope, instance);
    const detected = responseText
      ? detectTrailingAnnounceThenHalt(responseText)
      : null;
    if (!transport && (!detected || state.nudgeCount >= MAX_NUDGES_PER_USER_TURN_CHAIN)) return;
    state.lastHandledRequestCount = instance.requestCount;
    if (transport && state.transportRetryCount >= TRANSPORT_RECOVERY_DELAYS_MS.length) {
      this.host.emitSystemMessage?.(instanceId,
        'The provider connection failed again after two automatic recovery attempts. Work is preserved. Send "continue" to try again.',
        { source: 'transport-recovery', exhausted: true });
      return;
    }

    const requestCountAtCompletion = instance.requestCount;
    const delivery: ContinuationDelivery = {
      requestCount: requestCountAtCompletion,
      transport,
      sessionId: instance.sessionId,
      adapterGeneration: instance.adapterGeneration,
      provider: instance.provider,
      prompt: transport ? TRANSPORT_RECOVERY_PROMPT : [
        ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX,
        'Execute that action now; do not narrate another plan and stop again.',
        `Announced intent: "${detected!.excerpt}"`,
      ].join(' '),
      abortController: new AbortController(),
    };
    state.pending = delivery;
    const scheduledState = state;
    queueMicrotask(() => {
      void this.deliver(
        instanceId,
        requestCountAtCompletion,
        delivery,
        scheduledState,
      ).catch((error: unknown) => {
        logger.warn('Regular-session continuation failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private async deliver(
    instanceId: string,
    requestCountAtCompletion: number,
    delivery: ContinuationDelivery,
    state: ContinuationState,
  ): Promise<void> {
    if (!this.isDeliveryCurrent(instanceId, requestCountAtCompletion, state)) return;

    try {
      if (delivery.transport) {
        await waitForTransportRecovery(
          TRANSPORT_RECOVERY_DELAYS_MS[state.transportRetryCount],
          delivery.abortController!.signal,
        );
        if (!this.isDeliveryCurrent(instanceId, requestCountAtCompletion, state)) return;
      }
      try {
        await this.host.waitForInstanceSettled(instanceId, {
          timeoutMs: SETTLEMENT_TIMEOUT_MS,
          signal: delivery.abortController?.signal,
        });
      } catch (error: unknown) {
        if (!this.isDeliveryCurrent(instanceId, requestCountAtCompletion, state)) return;
        logger.warn('Announce-then-halt continuation timed out waiting for settlement', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const instance = this.host.getInstance(instanceId);
      if (
        !this.isDispatchEligible(instanceId, requestCountAtCompletion, state)
      ) {
        logger.info('Announce-then-halt continuation suppressed before delivery', {
          instanceId,
          requestCountAtCompletion,
          currentRequestCount: instance?.requestCount,
          status: instance?.status,
        });
        return;
      }

      await this.host.sendInput(
        instanceId,
        delivery.prompt,
        undefined,
        {
          autoContinuation: true,
          signal: delivery.abortController?.signal,
          beforeProviderDispatch: () => {
            if (!this.isDispatchEligible(instanceId, requestCountAtCompletion, state)) {
              delivery.abortController?.abort();
              const error = new Error('Regular-session continuation became ineligible before provider dispatch');
              error.name = 'AbortError';
              throw error;
            }
            if (delivery.transport) {
              state.transportRetryCount += 1;
              this.host.emitSystemMessage?.(instanceId,
                `Resuming after the provider connection dropped (attempt ${state.transportRetryCount} of 2). Completed work will be preserved.`,
                { source: 'transport-recovery', attempt: state.transportRetryCount });
            } else {
              state.nudgeCount += 1;
            }
            // Publishing the notice can synchronously invoke Stop observers.
            if (delivery.abortController?.signal.aborted) {
              const error = new Error('Regular-session continuation cancelled during dispatch notice');
              error.name = 'AbortError';
              throw error;
            }
            // ACP completes inside sendInput, before its promise settles. Free
            // the delivery slot now so a failed retry can schedule its successor.
            state.pending = undefined;
          },
        },
      );
    } finally {
      const current = this.states.get(instanceId);
      if (
        current === state
        && current.pending === delivery
      ) {
        current.pending = undefined;
      }
    }
  }

  private isDeliveryCurrent(
    instanceId: string,
    requestCountAtCompletion: number,
    state: ContinuationState,
  ): boolean {
    return this.started
      && this.states.get(instanceId) === state
      && !state.suppressed
      && state.pending?.requestCount === requestCountAtCompletion
      && state.pending.abortController?.signal.aborted !== true;
  }

  private isDispatchEligible(
    instanceId: string,
    requestCountAtCompletion: number,
    state: ContinuationState,
  ): boolean {
    const instance = this.host.getInstance(instanceId);
    return this.isDeliveryCurrent(instanceId, requestCountAtCompletion, state)
      && instance !== undefined
      && isEligibleRootSession(instance)
      && instance.requestCount === requestCountAtCompletion
      && (!state.pending?.transport || (
        instance.sessionId === state.pending.sessionId
        && instance.adapterGeneration === state.pending.adapterGeneration
        && instance.provider === state.pending.provider
      ))
      && READY_FOR_AUTOMATIC_INPUT.has(instance.status)
      && !this.isAutomaticInputPaused()
      && !this.hasManagedLoopOwnership(instanceId)
      && !this.asyncWorkRegistry.hasInhibitor(instanceId);
  }

  private isAutomaticInputPaused(): boolean {
    try {
      return this.isPaused();
    } catch (error: unknown) {
      logger.warn('Could not establish pause state; suppressing regular continuation', {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private hasManagedLoopOwnership(instanceId: string): boolean {
    try {
      return this.isManagedLoopInstance(instanceId);
    } catch (error: unknown) {
      logger.warn('Could not establish managed-loop ownership; suppressing regular continuation', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}

let activeContinuation: InstanceAnnounceThenHaltContinuation | null = null;

export function initializeInstanceAnnounceThenHaltContinuation(
  host: InstanceAnnounceThenHaltContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceAnnounceThenHaltContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceAnnounceThenHaltContinuation(
    getInstanceAsyncWorkRegistry(),
    host,
    isManagedLoopInstance,
    isPaused,
  );
  activeContinuation.start();
  registerCleanup(() => {
    activeContinuation?.stop();
    activeContinuation = null;
  });
  return activeContinuation;
}

export function _disposeInstanceAnnounceThenHaltContinuationForTesting(): void {
  activeContinuation?.stop();
  activeContinuation = null;
}
