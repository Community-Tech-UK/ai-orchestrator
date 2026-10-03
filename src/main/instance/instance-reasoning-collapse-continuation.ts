/** Provider-ending detector and preparation; the shared dispatcher owns every prompt. */
import type { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope, TurnEndingClassification } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceContinuationDispatch, type ContinuationReservation, type InstanceContinuationDispatchHost } from './instance-continuation-dispatch';
import { classifyTurnEnding } from '../cli/turn-ending-classifier';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getInstanceAsyncWorkRegistry, type InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { clearInstanceTurnEnding, getInstanceTurnEnding, recordInstanceTurnEnding, invalidateInstanceRecoveryEpoch } from './instance-turn-ending-state';
import { turnContinuationPolicy } from './turn-ending-continuation-policy';
export { CONTENT_FILTER_CONTINUATION_PROMPT, CONTENT_FILTER_NOTICE,
  REASONING_COLLAPSE_CONTINUATION_PROMPT, REASONING_COLLAPSE_NOTICE } from './turn-ending-continuation-policy';

const logger = getLogger('InstanceTurnEndingContinuation');
export const MAX_REASONING_COLLAPSE_CONTINUATIONS = 2;
const READY = new Set<Instance['status']>(['idle', 'ready']);
const CANCELLING = new Set<Instance['status']>([
  'interrupting', 'cancelling', 'interrupt-escalating', 'cancelled', 'terminated',
  'superseded', 'failed', 'error', 'hibernated', 'waking',
]);

export interface InstanceReasoningCollapseContinuationHost extends InstanceContinuationDispatchHost {
  on: Pick<EventEmitter, 'on'>['on'];
  off: Pick<EventEmitter, 'off'>['off'];
  getInstance(instanceId: string): Instance | undefined;
  emitSystemMessage?(instanceId: string, content: string, metadata?: Record<string, unknown>): void;
}
interface Pending {
  classification: TurnEndingClassification;
  reservation: ContinuationReservation;
}
interface TurnState { turnCutOff: boolean; pending?: Pending }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function completionMetadata(envelope: ProviderRuntimeEventEnvelope): Record<string, unknown> | undefined {
  return record(record(envelope.raw?.payload)?.['metadata']);
}
export function isReasoningCollapseCompletion(envelope: ProviderRuntimeEventEnvelope): boolean {
  return envelope.event.kind === 'complete' && (envelope.event.turnEnding?.reasoningCollapsed === true
    || completionMetadata(envelope)?.['reasoningCollapsed'] === true);
}
export function isContentFilterCompletion(envelope: ProviderRuntimeEventEnvelope): boolean {
  return envelope.event.kind === 'complete' && (envelope.event.turnEnding?.reason === 'content_filter'
    || completionMetadata(envelope)?.['contentFilterBlocked'] === true);
}

export class InstanceReasoningCollapseContinuation {
  private readonly states = new Map<string, TurnState>();
  private readonly endingIds = new Set<string>();
  private readonly wakingIds = new Set<string>();
  private started = false;
  private readonly onStateChanged = (event: {
    instanceId: string; status: Instance['status']; previousStatus?: Instance['status'];
  }): void => {
    const state = this.states.get(event.instanceId);
    if (event.status === 'respawning') {
      this.state(event.instanceId).turnCutOff = event.previousStatus === 'busy';
    } else if (state && CANCELLING.has(event.status)) {
      this.cancel(state);
    }
    if (event.status === 'waking') this.wakingIds.add(event.instanceId);
    else if (CANCELLING.has(event.status)) this.wakingIds.delete(event.instanceId);
    if (event.status === 'hibernated') {
      const reason = getInstanceTurnEnding(event.instanceId);
      if (reason) this.host.emitSystemMessage?.(event.instanceId,
        `This session was hibernated after stopping because of ${reason.replaceAll('_', ' ')}. Work is preserved.`,
        { source: 'turn-ending-hibernation', reason });
    }
    // Adapter spawn can emit idle before lifecycle restoration finishes at ready.
    if (event.status === 'ready' && (this.wakingIds.delete(event.instanceId) || event.previousStatus === 'waking')) {
      const reason = getInstanceTurnEnding(event.instanceId);
      if (reason) this.host.emitSystemMessage?.(event.instanceId,
        `This session last stopped because of ${reason.replaceAll('_', ' ')}. Work is preserved.`
          + ((reason === 'max_output' || reason === 'content_filter') && this.dispatch.attempts(event.instanceId, 'cutoff') < 2
            ? ' Send "continue" when you are ready to resume.' : ''),
        { source: 'turn-ending-wake', reason });
    }
  };
  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    const { event, instanceId } = envelope;
    if (event.kind === 'output' && event.messageType === 'system' && event.metadata?.['autoRespawn'] === true) {
      const state = this.states.get(instanceId);
      const cutOff = state?.turnCutOff === true || event.metadata['recoveryCause'] === 'stuck';
      if (state) state.turnCutOff = false;
      if (cutOff && READY.has(this.host.getInstance(instanceId)?.status as Instance['status'])) {
        this.observeEnding(instanceId, { reason: 'crash', evidence: 'restarted_active_turn' });
      }
      return;
    }
    if (event.kind === 'exit') {
      if (event.turnEnding?.reason === 'dangling_tool_result') this.observeEnding(instanceId, event.turnEnding);
      return;
    }
    if (event.kind !== 'complete' && event.kind !== 'error') return;
    if (this.crashOnly) return;
    const instance = this.host.getInstance(instanceId);
    if (!instance || (event.kind === 'complete' && event.requestCountAtCompletion !== undefined
      && event.requestCountAtCompletion !== instance.requestCount)) return;
    const payload = record(envelope.raw?.payload);
    const classification = event.turnEnding ?? classifyTurnEnding({
      kind: event.kind, metadata: { ...(event.stopReason ? { stopReason: event.stopReason } : {}), ...(event.finish ? { finish: event.finish } : {}), ...completionMetadata(envelope) }, raw: envelope.raw?.payload,
      text: typeof payload?.['content'] === 'string' ? payload['content'] : typeof payload?.['result'] === 'string' ? payload['result'] : undefined,
      error: event.kind === 'error' ? envelope.raw?.payload : undefined,
    });
    this.observeEnding(instanceId, classification);
  };
  private readonly onInputStarted = (event: { instanceId: string; autoContinuation: boolean }): void => {
    if (event.autoContinuation) return;
    const state = this.states.get(event.instanceId);
    if (state) this.cancel(state);
  };
  private readonly onInterruptRequested = ({ instanceId }: { instanceId: string }): void => {
    const state = this.states.get(instanceId);
    if (state) this.cancel(state);
  };
  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.dispatch.cancel(this.states.get(instanceId)?.pending?.reservation);
    this.states.delete(instanceId);
    this.endingIds.delete(instanceId);
    this.wakingIds.delete(instanceId);
    clearInstanceTurnEnding(instanceId);
  };
  constructor(
    asyncWorkRegistry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceReasoningCollapseContinuationHost,
    isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    isPaused: () => boolean = () => false,
    private readonly crashOnly = false,
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
    this.host.on('instance:state-changed', this.onStateChanged);
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:input-started', this.onInputStarted);
    this.host.on('instance:interrupt-requested', this.onInterruptRequested);
    this.host.on('instance:removed', this.onInstanceRemoved);
  }
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.ownsDispatch) this.dispatch.stop();
    this.host.off('instance:state-changed', this.onStateChanged);
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:input-started', this.onInputStarted);
    this.host.off('instance:interrupt-requested', this.onInterruptRequested);
    this.host.off('instance:removed', this.onInstanceRemoved);
    for (const [id, state] of this.states) { this.cancel(state); clearInstanceTurnEnding(id); invalidateInstanceRecoveryEpoch(id); }
    this.states.clear();
    for (const id of this.endingIds) { clearInstanceTurnEnding(id); invalidateInstanceRecoveryEpoch(id); }
    this.endingIds.clear();
    this.wakingIds.clear();
  }
  private state(instanceId: string): TurnState {
    let state = this.states.get(instanceId);
    if (!state) { state = { turnCutOff: false }; this.states.set(instanceId, state); }
    return state;
  }
  private cancel(state: TurnState): void {
    state.turnCutOff = false;
    this.dispatch.cancel(state.pending?.reservation);
    state.pending = undefined;
  }
  private observeEnding(instanceId: string, classification: TurnEndingClassification): void {
    if (!this.host.getInstance(instanceId)) return;
    this.endingIds.add(instanceId);
    if (classification.reason === 'completed' && classification.evidence === 'client_cancelled'
      && getInstanceTurnEnding(instanceId) === 'doom_loop') return;
    const previous = this.states.get(instanceId);
    if (previous?.pending && (classification.reason !== previous.pending.classification.reason
      || classification.autoContinueSuppressed || classification.visibleAnswerComplete)) this.cancel(previous);
    recordInstanceTurnEnding(instanceId, classification.reason);
    this.dispatch.observeEnding(instanceId, classification);
    if (classification.reason === 'completed') return;
    const policy = turnContinuationPolicy(classification.reason, classification.reasoningCollapsed);
    this.host.emitSystemMessage?.(instanceId, policy.notice, { source: policy.source });
    // A process crash is resumed only after the lifecycle announces successful restart.
    if (classification.reason === 'crash' && classification.evidence !== 'restarted_active_turn') return;
    if (!policy.prompt || classification.autoContinueSuppressed || classification.visibleAnswerComplete
      || classification.providerRetrying) return;
    if (classification.reason === 'content_filter' && !classification.contentFilterFromTool) return;
    const instance = this.host.getInstance(instanceId);
    if (!instance) return;
    const state = this.state(instanceId);
    if (state.pending) return;
    if (this.dispatch.attempts(instanceId, 'cutoff') >= MAX_REASONING_COLLAPSE_CONTINUATIONS) {
      this.host.emitSystemMessage?.(instanceId,
        'The turn was cut off again after 2 automatic continuations. Work is preserved. Send "continue" to try again.',
        { source: policy.source, exhausted: true });
      return;
    }
    const reservation = this.dispatch.reserve({
      instanceId, trigger: 'cutoff', requestCount: instance.requestCount,
      prompt: policy.prompt, internalSource: policy.internalSource!, expectedEnding: classification.reason,
      isCurrent: () => this.started && this.states.get(instanceId) === state,
      onDispatch: (attempt) => this.host.emitSystemMessage?.(instanceId,
        `Continuing the ${classification.reason === 'crash' ? 'interrupted' : 'cut-off'} turn automatically (attempt ${attempt} of 2).`,
        { source: policy.source, attempt }),
      onCommitted: () => { state.pending = undefined; },
    });
    if (!reservation) return;
    const pending: Pending = { classification, reservation };
    state.pending = pending;
    void this.dispatch.dispatch(reservation, {
      prepare: async (adapter, signal) => classification.reason !== 'content_filter'
        || await adapter?.prepareContentFilterRecovery?.(signal) === true,
    }).catch(() => {
      logger.warn('Provider turn continuation failed', { instanceId, reason: classification.reason });
    }).finally(() => { if (state.pending === pending) state.pending = undefined; });
  }
}

let activeContinuation: InstanceReasoningCollapseContinuation | null = null;
export function initializeInstanceReasoningCollapseContinuation(
  host: InstanceReasoningCollapseContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceReasoningCollapseContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceReasoningCollapseContinuation(getInstanceAsyncWorkRegistry(), host, isManagedLoopInstance, isPaused);
  activeContinuation.start();
  registerCleanup(() => { activeContinuation?.stop(); activeContinuation = null; });
  return activeContinuation;
}
export function _disposeInstanceReasoningCollapseContinuationForTesting(): void {
  activeContinuation?.stop(); activeContinuation = null;
}
