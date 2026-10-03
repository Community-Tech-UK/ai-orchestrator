import type { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { detectTrailingAnnounceThenHalt } from '../orchestration/announce-then-halt-detector';
import { InstanceContinuationDispatch, type ContinuationReservation, type ContinuationRequest, type InstanceContinuationDispatchHost } from './instance-continuation-dispatch';
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
export const ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX =
  'Continue now. You ended the last turn by announcing the next action instead of executing it.';

interface ContinuationState {
  lastHandledRequestCount?: number;
  pending?: ContinuationReservation;
}
export interface InstanceAnnounceThenHaltContinuationHost extends InstanceContinuationDispatchHost {
  on: Pick<EventEmitter, 'on'>['on'];
  off: Pick<EventEmitter, 'off'>['off'];
  getInstance(instanceId: string): Instance | undefined;
  emitSystemMessage?(instanceId: string, content: string, metadata?: Record<string, unknown>): void;
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

export class InstanceAnnounceThenHaltContinuation {
  private readonly states = new Map<string, ContinuationState>();
  private readonly manualTurnAssistantBaselines = new Map<string, string | undefined>();
  private started = false;

  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    if (envelope.event.kind !== 'complete') return;
    this.maybeSchedule(envelope);
  };

  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.dispatch.cancel(this.states.get(instanceId)?.pending);
    this.states.delete(instanceId);
    this.manualTurnAssistantBaselines.delete(instanceId);
  };

  private readonly onInputStarted = (event: InstanceInputStartedEvent): void => {
    if (event.autoContinuation) return;
    this.dispatch.cancel(this.states.get(event.instanceId)?.pending);
    this.states.delete(event.instanceId);
    const instance = this.host.getInstance(event.instanceId);
    const latestMessage = instance ? latestConversationMessage(instance) : undefined;
    this.manualTurnAssistantBaselines.set(
      event.instanceId,
      latestMessage?.type === 'assistant' ? latestMessage.id : undefined,
    );
  };

  constructor(
    asyncWorkRegistry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceAnnounceThenHaltContinuationHost,
    isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    isPaused: () => boolean = () => false,
    dispatch?: InstanceContinuationDispatch,
  ) {
    this.ownsDispatch = dispatch === undefined;
    this.dispatch = dispatch ?? new InstanceContinuationDispatch(asyncWorkRegistry, host, isManagedLoopInstance, isPaused);
  }
  private readonly dispatch: InstanceContinuationDispatch;
  private readonly ownsDispatch: boolean;

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.ownsDispatch) this.dispatch.start();
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:removed', this.onInstanceRemoved);
    this.host.on('instance:input-started', this.onInputStarted);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.ownsDispatch) this.dispatch.stop();
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:removed', this.onInstanceRemoved);
    this.host.off('instance:input-started', this.onInputStarted);
    for (const state of this.states.values()) {
      this.dispatch.cancel(state.pending);
    }
    this.states.clear();
    this.manualTurnAssistantBaselines.clear();
  }

  private maybeSchedule(envelope: ProviderRuntimeEventEnvelope): void {
    const { instanceId, event } = envelope;
    const instance = this.host.getInstance(instanceId);
    if (
      !instance
      || event.kind !== 'complete'
      || (!isRecoverableTransportCompletion(envelope) && (event.turnEnding?.reason !== undefined && event.turnEnding.reason !== 'completed'))
      || event.turnEnding?.autoContinueSuppressed === true
      || event.degradedReason !== undefined
      || event.quota?.exhausted === true
      || event.rateLimit?.remaining === 0
    ) {
      return;
    }

    const transport = isRecoverableTransportCompletion(envelope);
    const request: ContinuationRequest = {
      instanceId, trigger: transport ? 'cursor-transport' : 'announce', requestCount: instance.requestCount,
      prompt: '', internalSource: 'announce-then-halt-continuation',
      isCurrent: () => this.started,
    };
    const attempts = this.dispatch.attempts(instanceId, request.trigger);
    // Exhausted transport still emits its source-specific notice below.
    if (!this.dispatch.canRequest(request) && !(transport && attempts >= TRANSPORT_RECOVERY_DELAYS_MS.length)) return;

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
      state = {};
      this.states.set(instanceId, state);
    }
    if (
      state.pending !== undefined
      || state.lastHandledRequestCount === instance.requestCount
    ) {
      return;
    }

    const responseText = readCompletionText(envelope, instance);
    const detected = responseText
      ? detectTrailingAnnounceThenHalt(responseText)
      : null;
    if (!transport && (!detected || attempts >= 1)) return;
    state.lastHandledRequestCount = instance.requestCount;
    if (transport && attempts >= TRANSPORT_RECOVERY_DELAYS_MS.length) {
      this.host.emitSystemMessage?.(instanceId,
        'The provider connection failed again after two automatic recovery attempts. Work is preserved. Send "continue" to try again.',
        { source: 'transport-recovery', exhausted: true });
      return;
    }

    request.prompt = transport ? TRANSPORT_RECOVERY_PROMPT : [
      ANNOUNCE_THEN_HALT_CONTINUATION_PROMPT_PREFIX,
      'Execute that action now; do not narrate another plan and stop again.',
      `Announced intent: "${detected!.excerpt}"`,
    ].join(' ');
    request.onDispatch = (attempt) => {
      if (transport) this.host.emitSystemMessage?.(instanceId,
        `Resuming after the provider connection dropped (attempt ${attempt} of 2). Completed work will be preserved.`,
        { source: 'transport-recovery', attempt });
    };
    request.onCommitted = () => { state.pending = undefined; };
    const reservation = this.dispatch.reserve(request);
    if (!reservation) return;
    state.pending = reservation;
    queueMicrotask(() => {
      void this.deliver(reservation, attempts).catch(() => {
        logger.warn('Regular-session continuation failed', { instanceId });
      }).finally(() => { if (state.pending === reservation) state.pending = undefined; });
    });
  }

  private async deliver(reservation: ContinuationReservation, attempts: number): Promise<void> {
    if (reservation.request.trigger === 'cursor-transport') {
      await waitForTransportRecovery(TRANSPORT_RECOVERY_DELAYS_MS[attempts], reservation.abortController.signal);
    }
    if (reservation.abortController.signal.aborted) return;
    await this.dispatch.dispatch(reservation);
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
