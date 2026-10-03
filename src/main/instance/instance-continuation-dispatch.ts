import type { EventEmitter } from 'events';
import type { ProviderTurnEndingReason, TurnEndingClassification } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import type { InternalInputSource } from '../../shared/types/input-provenance.types';
import type { AdapterInputRetryReason } from '../cli/adapters/base-cli-adapter.types';
import type { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { CONTINUATION_DISPATCH_POLICY, type ContinuationTrigger } from './turn-ending-continuation-policy';
import { clearInstanceTurnEnding, getInstanceTurnEnding, invalidateInstanceRecoveryEpoch } from './instance-turn-ending-state';

export interface ContinuationRecoveryAdapter {
  hasProviderAutoContinuation?(): Promise<boolean>;
  hasPendingProviderAutoContinuation?(): boolean;
  prepareContentFilterRecovery?(signal?: AbortSignal): Promise<boolean>;
}
export type ContinuationInstance = Pick<Instance, 'status' | 'requestCount'>
  & Partial<Pick<Instance, 'parentId' | 'launchMode' | 'waitReason' | 'sessionId' | 'adapterGeneration' | 'provider'>>;
export interface InstanceContinuationDispatchHost {
  on?: Pick<EventEmitter, 'on'>['on'];
  off?: Pick<EventEmitter, 'off'>['off'];
  getInstance(instanceId: string): ContinuationInstance | undefined;
  getAdapter?(instanceId: string): unknown;
  wakeInstance?(instanceId: string): Promise<void>;
  waitForInstanceSettled(instanceId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  sendInput(instanceId: string, message: string, attachments?: undefined, options?: {
    autoContinuation?: boolean; internalSource?: InternalInputSource; signal?: AbortSignal;
    beforeProviderDispatch?: () => void;
    assertProviderDispatchCurrent?: (retryReason?: AdapterInputRetryReason) => void;
  }): Promise<void>;
}
export interface ContinuationRequest {
  instanceId: string;
  trigger: ContinuationTrigger;
  requestCount: number;
  prompt: string;
  internalSource: InternalInputSource;
  expectedEnding?: ProviderTurnEndingReason;
  /** Detection/preparation state specific to the source, never common guards. */
  isCurrent?: () => boolean;
  onDispatch?: (attempt: number) => void;
  onCommitted?: () => void;
}
export interface ContinuationReservation {
  request: ContinuationRequest;
  abortController: AbortController;
  instance: ContinuationInstance;
}
interface LogicalTurnState {
  attempts: Map<string, number>;
  suppressed: boolean;
  lastDispatchedRequestCount?: number;
}
const READY = new Set<Instance['status']>(['idle', 'ready']);
const UNAVAILABLE = new Set<Instance['status']>([
  'initializing', 'waiting_for_input', 'waiting_for_permission', 'interrupting', 'cancelling',
  'interrupt-escalating', 'terminated', 'failed', 'error', 'cancelled', 'superseded',
  'respawning', 'hibernating', 'waking', 'degraded',
]);
const STOPPING = new Set<Instance['status']>([
  'interrupting', 'cancelling', 'interrupt-escalating', 'cancelled', 'terminated', 'superseded',
]);

/** Sole runtime owner of the next Harness continuation prompt. */
export class InstanceContinuationDispatch {
  private readonly pending = new Map<string, ContinuationReservation>();
  private readonly turns = new Map<string, LogicalTurnState>();
  private readonly sending = new Set<ContinuationReservation>();
  private started = false;
  private readonly onInput = (event: { instanceId: string; autoContinuation: boolean }): void => {
    if (event.autoContinuation) return;
    this.cancelInstance(event.instanceId);
    this.turns.delete(event.instanceId);
    clearInstanceTurnEnding(event.instanceId);
    invalidateInstanceRecoveryEpoch(event.instanceId);
  };
  private readonly onInterrupt = ({ instanceId }: { instanceId: string }): void => {
    this.cancelInstance(instanceId);
    this.turn(instanceId).suppressed = true;
    invalidateInstanceRecoveryEpoch(instanceId);
  };
  private readonly onRemoved = (instanceId: string): void => {
    this.cancelInstance(instanceId);
    this.turns.delete(instanceId);
    clearInstanceTurnEnding(instanceId);
    invalidateInstanceRecoveryEpoch(instanceId);
  };
  private readonly onState = ({ instanceId, status }: { instanceId: string; status: Instance['status'] }): void => {
    if (STOPPING.has(status)) { this.onInterrupt({ instanceId }); return; }
    const reservation = this.pending.get(instanceId);
    if (status === 'failed' || status === 'error' || status === 'respawning'
      || ((status === 'hibernated' || status === 'waking') && reservation
        && !CONTINUATION_DISPATCH_POLICY[reservation.request.trigger].allowWake)) {
      this.cancelInstance(instanceId);
      invalidateInstanceRecoveryEpoch(instanceId);
    }
  };
  constructor(
    private readonly registry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceContinuationDispatchHost,
    private readonly isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    private readonly isPaused: () => boolean = () => false,
  ) {}
  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.on?.('instance:input-started', this.onInput);
    this.host.on?.('instance:interrupt-requested', this.onInterrupt);
    this.host.on?.('instance:removed', this.onRemoved);
    this.host.on?.('instance:state-changed', this.onState);
  }
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.host.off?.('instance:input-started', this.onInput);
    this.host.off?.('instance:interrupt-requested', this.onInterrupt);
    this.host.off?.('instance:removed', this.onRemoved);
    this.host.off?.('instance:state-changed', this.onState);
    for (const reservation of [...this.pending.values(), ...this.sending]) reservation.abortController.abort();
    this.pending.clear();
    this.sending.clear();
    this.turns.clear();
  }
  attempts(instanceId: string, trigger: ContinuationTrigger): number {
    const budget = CONTINUATION_DISPATCH_POLICY[trigger].budget;
    return budget ? this.turns.get(instanceId)?.attempts.get(budget) ?? 0 : 0;
  }
  canRequest(request: ContinuationRequest): boolean {
    return this.started && this.guard(request, false);
  }
  reserve(request: ContinuationRequest): ContinuationReservation | undefined {
    if (!this.canRequest(request)) return undefined;
    const previous = this.pending.get(request.instanceId);
    if (previous) {
      if (CONTINUATION_DISPATCH_POLICY[previous.request.trigger].priority
        >= CONTINUATION_DISPATCH_POLICY[request.trigger].priority) return undefined;
      previous.abortController.abort();
    }
    const instance = this.host.getInstance(request.instanceId);
    if (!instance) return undefined;
    const reservation = { request, abortController: new AbortController(), instance: this.identity(instance) };
    this.pending.set(request.instanceId, reservation);
    return reservation;
  }
  cancel(reservation: ContinuationReservation | undefined): void {
    if (!reservation) return;
    reservation.abortController.abort();
    if (this.pending.get(reservation.request.instanceId) === reservation) this.pending.delete(reservation.request.instanceId);
  }
  /** An authoritative terminal reason revokes a queued prompt from any source. */
  observeEnding(instanceId: string, classification: TurnEndingClassification): void {
    const reservation = this.pending.get(instanceId);
    if (reservation && (classification.reason === 'completed' || !this.endingMatches(reservation.request) || classification.autoContinueSuppressed
      || classification.visibleAnswerComplete || classification.providerRetrying)) this.cancel(reservation);
  }
  async dispatch(reservation: ContinuationReservation, options: {
    settle?: boolean;
    prepare?: (adapter: ContinuationRecoveryAdapter | undefined, signal: AbortSignal) => Promise<boolean>;
  } = {}): Promise<boolean> {
    const { request, abortController } = reservation;
    const { instanceId } = request;
    const { signal } = abortController;
    try {
      if (!this.started || this.pending.get(instanceId) !== reservation || signal.aborted) return false;
      if (options.settle !== false) {
        try { await this.host.waitForInstanceSettled(instanceId, { timeoutMs: 60_000, signal }); }
        catch { return false; }
      }
      if (!this.current(reservation)) return false;
      if (reservation.instance.status === 'hibernated' && this.host.wakeInstance) {
        // Resolve a legitimate wake before querying the newly created provider.
        // Every other replacement remains a stale-provider cancellation.
        await this.host.wakeInstance(instanceId);
        if (!this.current(reservation)) return false;
        const awakened = this.host.getInstance(instanceId);
        if (!awakened || !READY.has(awakened.status)) return false;
        reservation.instance = this.identity(awakened);
      }
      const adapter = this.host.getAdapter?.(instanceId) as ContinuationRecoveryAdapter | undefined;
      try {
        if (await adapter?.hasProviderAutoContinuation?.()) return false;
        if (options.prepare && !(await options.prepare(adapter, signal))) return false;
      } catch { return false; }
      if (!this.current(reservation)) return false;
      let dispatched = false;
      this.sending.add(reservation);
      await this.host.sendInput(instanceId, request.prompt, undefined, {
        autoContinuation: true, internalSource: request.internalSource, signal,
        assertProviderDispatchCurrent: (retryReason) => {
          if (dispatched) this.assertCommittedCurrent(reservation, retryReason);
        },
        beforeProviderDispatch: () => {
          this.assertCurrent(reservation, adapter);
          const attempt = this.attempts(instanceId, request.trigger) + 1;
          request.onDispatch?.(attempt);
          // A notice callback can synchronously Stop, activate a goal or acquire ownership.
          this.assertCurrent(reservation, adapter);
          const budget = CONTINUATION_DISPATCH_POLICY[request.trigger].budget;
          if (budget) this.turn(instanceId).attempts.set(budget, attempt);
          this.turn(instanceId).lastDispatchedRequestCount = request.requestCount;
          dispatched = true;
          // ACP complete may fire before sendInput resolves; its successor owns the next request count.
          this.pending.delete(instanceId);
          request.onCommitted?.();
        },
      });
      return dispatched;
    } finally {
      this.sending.delete(reservation);
      if (this.pending.get(instanceId) === reservation) this.pending.delete(instanceId);
    }
  }
  private assertCurrent(reservation: ContinuationReservation, adapter: ContinuationRecoveryAdapter | undefined): void {
    let eligible = false;
    try {
      eligible = this.current(reservation) && !adapter?.hasPendingProviderAutoContinuation?.()
        && (!this.host.getAdapter || this.host.getAdapter(reservation.request.instanceId) === adapter);
    } catch { /* Ownership uncertainty fails closed. */ }
    if (eligible) return;
    this.cancel(reservation);
    const error = new Error('Continuation became ineligible before provider dispatch');
    error.name = 'AbortError';
    throw error;
  }
  private assertCommittedCurrent(reservation: ContinuationReservation, retryReason?: AdapterInputRetryReason): void {
    const { request, abortController } = reservation;
    const current = this.host.getInstance(request.instanceId);
    const policy = CONTINUATION_DISPATCH_POLICY[request.trigger];
    let eligible = false;
    try {
      eligible = this.started && this.sending.has(reservation) && !abortController.signal.aborted && current !== undefined
        && !this.turns.get(request.instanceId)?.suppressed
        && (this.endingMatches(request) || (retryReason === 'context-overflow'
          && getInstanceTurnEnding(request.instanceId) === 'context_overflow'))
        && (READY.has(current.status) || current.status === 'busy')
        && (!policy.rootOnly || (current.parentId === null && current.launchMode === 'orchestrated' && current.waitReason === undefined))
        && !this.isPaused() && !this.isManagedLoopInstance(request.instanceId)
        && (policy.allowInhibitor || !this.registry.hasInhibitor(request.instanceId));
    } catch { /* Eligibility uncertainty fails closed. */ }
    if (eligible) return;
    this.cancel(reservation);
    const error = new Error('Continuation owner became ineligible after provider admission');
    error.name = 'AbortError';
    throw error;
  }
  private current(reservation: ContinuationReservation): boolean {
    const { request, instance, abortController } = reservation;
    const current = this.host.getInstance(request.instanceId);
    const waking = instance.status === 'hibernated' && CONTINUATION_DISPATCH_POLICY[request.trigger].allowWake;
    return this.started && this.pending.get(request.instanceId) === reservation && !abortController.signal.aborted
      && this.guard(request, true, this.sending.has(reservation)) && current !== undefined
      && current.provider === instance.provider
      && (waking || (current.sessionId === instance.sessionId && current.adapterGeneration === instance.adapterGeneration));
  }
  private guard(request: ContinuationRequest, dispatch: boolean, preparing = false): boolean {
    const instance = this.host.getInstance(request.instanceId);
    const policy = CONTINUATION_DISPATCH_POLICY[request.trigger];
    const turn = this.turns.get(request.instanceId);
    try {
      return instance !== undefined && instance.requestCount === request.requestCount
        && !turn?.suppressed && turn?.lastDispatchedRequestCount !== request.requestCount
        && (!policy.rootOnly || (instance.parentId === null && instance.launchMode === 'orchestrated' && instance.waitReason === undefined))
        && (!dispatch ? !UNAVAILABLE.has(instance.status) : READY.has(instance.status)
          || (preparing && instance.status === 'busy') || (policy.allowWake && instance.status === 'hibernated'))
        && (policy.limit === undefined || this.attempts(request.instanceId, request.trigger) < policy.limit)
        && this.endingMatches(request) && request.isCurrent?.() !== false
        && !this.isPaused() && !this.isManagedLoopInstance(request.instanceId)
        && (policy.allowInhibitor || !this.registry.hasInhibitor(request.instanceId));
    } catch { return false; }
  }
  private endingMatches(request: ContinuationRequest): boolean {
    const ending = getInstanceTurnEnding(request.instanceId);
    return request.expectedEnding !== undefined ? ending === request.expectedEnding
      : request.trigger === 'cursor-transport' ? ending === undefined || ending === 'truncated_transport'
      : ending === undefined;
  }
  private identity(instance: ContinuationInstance): ContinuationInstance {
    return { status: instance.status, requestCount: instance.requestCount, provider: instance.provider,
      sessionId: instance.sessionId, adapterGeneration: instance.adapterGeneration };
  }
  private turn(instanceId: string): LogicalTurnState {
    let state = this.turns.get(instanceId);
    if (!state) { state = { attempts: new Map<string, number>(), suppressed: false }; this.turns.set(instanceId, state); }
    return state;
  }
  private cancelInstance(instanceId: string): void {
    this.cancel(this.pending.get(instanceId));
    for (const reservation of this.sending) {
      if (reservation.request.instanceId === instanceId) reservation.abortController.abort();
    }
  }
}
