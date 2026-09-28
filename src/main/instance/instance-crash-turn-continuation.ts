/**
 * Crash-turn continuation (plan 2026-09-28-crash-turn-auto-continue).
 *
 * When a provider CLI dies mid-turn, Harness restarts it — natively resumed,
 * or as a fresh session with the continuity preamble queued — but the turn
 * that was running is gone and the session sits idle until the user sends
 * "continue" (Copilot session pogg12k15 needed that three times in a day).
 * This sends that continuation automatically.
 *
 * A turn counts as cut off when an automatic restart completes (the
 * `autoRespawn` system notice) and either the instance went `busy →
 * respawning` (unexpected exit) or the notice says `recoveryCause: 'stuck'`
 * (the stuck-process restart, which only fires on an active turn). A user
 * interrupt goes through `interrupting`, and a process that died while idle
 * was never `busy`, so neither qualifies. A restart that already handed the
 * session a new turn (`respawning → busy`) is left alone.
 *
 * Guard rails mirror the announce-then-halt continuation: root orchestrated
 * sessions only, never while paused, loop-managed, parked, or with background
 * work pending; at most two automatic continuations per user turn; any user
 * input, interrupt or terminal state cancels a pending one; and the
 * request-count fence stops it if a queued user message dispatches first.
 */

import type { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import type { InternalInputSource } from '../../shared/types/input-provenance.types';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import {
  getInstanceAsyncWorkRegistry,
  type InstanceAsyncWorkRegistry,
} from './instance-async-work-registry';

const logger = getLogger('InstanceCrashTurnContinuation');

const SETTLEMENT_TIMEOUT_MS = 60_000;
export const MAX_CRASH_TURN_CONTINUATIONS = 2;
const READY_FOR_AUTOMATIC_INPUT = new Set<Instance['status']>(['idle', 'ready']);
/** A pending continuation is abandoned when the session moves into any of these. */
const CANCELLING_STATUSES = new Set<Instance['status']>([
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'cancelled',
  'terminated',
  'superseded',
  'failed',
  'error',
]);

export const CRASH_TURN_CONTINUATION_PROMPT = [
  'Your previous turn was cut off because the agent process stopped unexpectedly, and Harness has restarted this session.',
  '',
  'Pick the task back up from where that turn stopped. The conversation above is the record of what is already done: check the latest tool results and the current state of the files rather than assuming, keep completed work, and do not repeat completed steps. If the task was already finished, say so in one line instead of redoing it.',
].join('\n');

export interface InstanceCrashTurnContinuationHost {
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
      internalSource?: InternalInputSource;
      signal?: AbortSignal;
      beforeProviderDispatch?: () => void;
    },
  ): Promise<void>;
}

interface CrashTurnState {
  /** A turn was running when the process died (`busy → respawning`). */
  turnCutOff: boolean;
  /** Automatic continuations since the user last sent input. */
  attempts: number;
  pending?: { requestCount: number; abortController: AbortController };
}

function isAutoRespawnNotice(envelope: ProviderRuntimeEventEnvelope): { stuck: boolean } | null {
  const { event } = envelope;
  if (event.kind !== 'output' || event.messageType !== 'system' || event.metadata?.['autoRespawn'] !== true) {
    return null;
  }
  return { stuck: event.metadata['recoveryCause'] === 'stuck' };
}

export class InstanceCrashTurnContinuation {
  private readonly states = new Map<string, CrashTurnState>();
  private started = false;

  private readonly onStateChanged = (event: {
    instanceId: string;
    status: Instance['status'];
    previousStatus?: Instance['status'];
  }): void => {
    const state = this.states.get(event.instanceId);
    if (event.status === 'respawning') {
      // Each restart decides for itself: a marker left by an earlier restart
      // that never announced completion must not leak into this one.
      if (event.previousStatus === 'busy') this.state(event.instanceId).turnCutOff = true;
      else if (state) state.turnCutOff = false;
      return;
    }
    if (state && CANCELLING_STATUSES.has(event.status)) {
      this.cancel(event.instanceId, state);
    }
  };

  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    const notice = isAutoRespawnNotice(envelope);
    if (notice) this.maybeSchedule(envelope.instanceId, notice.stuck);
  };

  private readonly onInputStarted = (event: { instanceId: string; autoContinuation: boolean }): void => {
    if (event.autoContinuation) return;
    const state = this.states.get(event.instanceId);
    if (!state) return;
    // The user took over: a new turn chain starts with a fresh budget.
    this.cancel(event.instanceId, state);
    state.attempts = 0;
  };

  private readonly onInterruptRequested = ({ instanceId }: { instanceId: string }): void => {
    const state = this.states.get(instanceId);
    if (state) this.cancel(instanceId, state);
  };

  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.states.get(instanceId)?.pending?.abortController.abort();
    this.states.delete(instanceId);
  };

  constructor(
    private readonly asyncWorkRegistry: InstanceAsyncWorkRegistry,
    private readonly host: InstanceCrashTurnContinuationHost,
    private readonly isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    private readonly isPaused: () => boolean = () => false,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.on('instance:state-changed', this.onStateChanged);
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:input-started', this.onInputStarted);
    this.host.on('instance:interrupt-requested', this.onInterruptRequested);
    this.host.on('instance:removed', this.onInstanceRemoved);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.host.off('instance:state-changed', this.onStateChanged);
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:input-started', this.onInputStarted);
    this.host.off('instance:interrupt-requested', this.onInterruptRequested);
    this.host.off('instance:removed', this.onInstanceRemoved);
    for (const state of this.states.values()) state.pending?.abortController.abort();
    this.states.clear();
  }

  private state(instanceId: string): CrashTurnState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = { turnCutOff: false, attempts: 0 };
      this.states.set(instanceId, state);
    }
    return state;
  }

  private cancel(instanceId: string, state: CrashTurnState): void {
    state.turnCutOff = false;
    if (state.pending) {
      logger.info('Crash-turn continuation cancelled', { instanceId });
      state.pending.abortController.abort();
      state.pending = undefined;
    }
  }

  private maybeSchedule(instanceId: string, stuck: boolean): void {
    const state = this.states.get(instanceId);
    const turnCutOff = stuck || state?.turnCutOff === true;
    if (state) state.turnCutOff = false;
    const instance = this.host.getInstance(instanceId);
    if (!turnCutOff || !instance || instance.parentId !== null || instance.launchMode !== 'orchestrated') return;
    // Only a restart that settled the session idle left a turn unfinished.
    // `waitReason` is deliberately not checked here but at dispatch, after the
    // session settles: on the unexpected-exit path the notice lands while that
    // restart's own `respawning` wait reason is still set (it is cleared right
    // after), so an up-front check would suppress every continuation. (The
    // stuck-restart path never sets one.)
    if (!READY_FOR_AUTOMATIC_INPUT.has(instance.status)) return;

    const current = this.state(instanceId);
    if (current.pending) return;
    if (current.attempts >= MAX_CRASH_TURN_CONTINUATIONS) {
      this.host.emitSystemMessage?.(instanceId,
        `The session restarted again after ${MAX_CRASH_TURN_CONTINUATIONS} automatic continuations. Work is preserved. Send "continue" to try again.`,
        { source: 'crash-turn-continuation', exhausted: true });
      return;
    }

    const pending = { requestCount: instance.requestCount, abortController: new AbortController() };
    current.pending = pending;
    void this.deliver(instanceId, current, pending).catch((error: unknown) => {
      logger.warn('Crash-turn continuation failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (current.pending === pending) current.pending = undefined;
    });
  }

  private async deliver(
    instanceId: string,
    state: CrashTurnState,
    pending: NonNullable<CrashTurnState['pending']>,
  ): Promise<void> {
    const { signal } = pending.abortController;
    try {
      await this.host.waitForInstanceSettled(instanceId, { timeoutMs: SETTLEMENT_TIMEOUT_MS, signal });
    } catch (error: unknown) {
      if (!signal.aborted) {
        logger.warn('Crash-turn continuation timed out waiting for the session to settle', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (!this.isDispatchEligible(instanceId, state, pending)) {
      logger.info('Crash-turn continuation suppressed before delivery', {
        instanceId,
        status: this.host.getInstance(instanceId)?.status,
      });
      return;
    }

    logger.info('Continuing a turn cut off by a provider restart', { instanceId, attempt: state.attempts + 1 });
    await this.host.sendInput(instanceId, CRASH_TURN_CONTINUATION_PROMPT, undefined, {
      autoContinuation: true,
      internalSource: 'crash-turn-continuation',
      signal,
      beforeProviderDispatch: () => {
        if (!this.isDispatchEligible(instanceId, state, pending)) {
          pending.abortController.abort();
          const error = new Error('Crash-turn continuation became ineligible before provider dispatch');
          error.name = 'AbortError';
          throw error;
        }
        state.attempts += 1;
        this.host.emitSystemMessage?.(instanceId,
          `Continuing the interrupted turn automatically (attempt ${state.attempts} of ${MAX_CRASH_TURN_CONTINUATIONS}).`,
          { source: 'crash-turn-continuation', attempt: state.attempts });
        if (signal.aborted) {
          const error = new Error('Crash-turn continuation cancelled during dispatch notice');
          error.name = 'AbortError';
          throw error;
        }
      },
    });
  }

  private isDispatchEligible(
    instanceId: string,
    state: CrashTurnState,
    pending: NonNullable<CrashTurnState['pending']>,
  ): boolean {
    const instance = this.host.getInstance(instanceId);
    return this.started
      && this.states.get(instanceId) === state
      && state.pending === pending
      && !pending.abortController.signal.aborted
      && instance !== undefined
      && instance.parentId === null
      && READY_FOR_AUTOMATIC_INPUT.has(instance.status)
      && instance.waitReason === undefined
      && instance.requestCount === pending.requestCount
      && !this.guardSaysNo('pause state', () => this.isPaused(), instanceId)
      && !this.guardSaysNo('managed-loop ownership', () => this.isManagedLoopInstance(instanceId), instanceId)
      && !this.asyncWorkRegistry.hasInhibitor(instanceId);
  }

  /** A guard that cannot be evaluated suppresses the continuation (fail closed). */
  private guardSaysNo(name: string, guard: () => boolean, instanceId: string): boolean {
    try {
      return guard();
    } catch (error: unknown) {
      logger.warn(`Could not establish ${name}; suppressing crash-turn continuation`, {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}

let activeContinuation: InstanceCrashTurnContinuation | null = null;

export function initializeInstanceCrashTurnContinuation(
  host: InstanceCrashTurnContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceCrashTurnContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceCrashTurnContinuation(
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

export function _disposeInstanceCrashTurnContinuationForTesting(): void {
  activeContinuation?.stop();
  activeContinuation = null;
}
