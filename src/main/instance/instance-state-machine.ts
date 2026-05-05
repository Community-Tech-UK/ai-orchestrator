import type { InstanceStatus, OutputMessage } from '../../shared/types/instance.types';

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class IllegalTransitionError extends Error {
  constructor(from: InstanceStatus, to: InstanceStatus) {
    super(`Illegal transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Back-compat alias retained while callers migrate to IllegalTransitionError.
 *
 * @deprecated Prefer {@link IllegalTransitionError}.
 */
export class InvalidTransitionError extends IllegalTransitionError {
  constructor(from: InstanceStatus, to: InstanceStatus) {
    super(from, to);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Terminal states — once reached, no further transitions are allowed.
 */
const TERMINAL_STATES = new Set<InstanceStatus>(['terminated', 'failed']);

/**
 * Universal target states — reachable from any non-terminal state.
 */
const UNIVERSAL_TARGETS = new Set<InstanceStatus>(['terminated', 'failed', 'degraded', 'superseded']);

export const INSTANCE_SETTLED_DEBOUNCE_MS = 150;

/**
 * States that can represent a completed worker turn once assistant/error
 * output has been observed. The output requirement is load-bearing: startup
 * and transient idle states must not be treated as completed work.
 */
export const INSTANCE_SETTLED_STATUSES = new Set<InstanceStatus>([
  'idle',
  'waiting_for_input',
  'terminated',
  'error',
  'failed',
]);

export interface InstanceSettledPredicateInput {
  status: InstanceStatus;
  outputBuffer: readonly Pick<OutputMessage, 'id' | 'timestamp' | 'type'>[];
  activeTurnId?: string;
  interruptRequestId?: string;
  interruptPhase?: 'requested' | 'accepted' | 'completed' | 'timed-out' | 'escalated';
  afterTimestamp?: number;
  lastEventAt?: number;
  now?: number;
  debounceMs?: number;
}

export function isInstanceSettledStatus(status: InstanceStatus): boolean {
  return INSTANCE_SETTLED_STATUSES.has(status);
}

export function findLatestSettlingOutput(
  outputBuffer: readonly Pick<OutputMessage, 'id' | 'timestamp' | 'type'>[],
  afterTimestamp = 0,
): Pick<OutputMessage, 'id' | 'timestamp' | 'type'> | undefined {
  for (let index = outputBuffer.length - 1; index >= 0; index -= 1) {
    const message = outputBuffer[index];
    if (
      (message.type === 'assistant' || message.type === 'error')
      && message.timestamp >= afterTimestamp
    ) {
      return message;
    }
  }
  return undefined;
}

/**
 * Defines when a worker instance is safe for supervisors to evaluate.
 *
 * Predicate:
 * - status is idle-like or terminal;
 * - at least one assistant/error output exists after the watched turn starts;
 * - no provider turn id or interrupt lifecycle is still active;
 * - the latest state/output event is older than the debounce window.
 */
export function isInstanceSettled(input: InstanceSettledPredicateInput): boolean {
  if (!isInstanceSettledStatus(input.status)) {
    return false;
  }

  if (input.activeTurnId) {
    return false;
  }

  if (input.interruptRequestId && input.interruptPhase !== 'completed') {
    return false;
  }

  if (input.interruptPhase && input.interruptPhase !== 'completed') {
    return false;
  }

  if (!findLatestSettlingOutput(input.outputBuffer, input.afterTimestamp)) {
    return false;
  }

  const debounceMs = input.debounceMs ?? INSTANCE_SETTLED_DEBOUNCE_MS;
  const lastEventAt = input.lastEventAt ?? 0;
  const now = input.now ?? Date.now();
  return now - lastEventAt >= debounceMs;
}

/**
 * Explicit allowed transitions (excluding universal targets).
 * Universal targets (terminated, failed) are added dynamically for every
 * non-terminal source state at runtime.
 */
const TRANSITION_MAP: Readonly<Record<InstanceStatus, readonly InstanceStatus[]>> = {
  initializing:       ['ready', 'idle', 'error'],
  ready:              ['busy', 'idle', 'error', 'hibernating', 'respawning', 'interrupting', 'cancelled', 'initializing'],
  idle:               ['ready', 'error', 'hibernating', 'waiting_for_input', 'respawning', 'interrupting', 'cancelled', 'initializing'],
  busy:               ['idle', 'ready', 'waiting_for_input', 'waiting_for_permission', 'error', 'processing', 'thinking_deeply', 'interrupting', 'cancelling', 'respawning', 'cancelled', 'initializing'],
  processing:         ['idle', 'ready', 'busy', 'waiting_for_input', 'error', 'thinking_deeply', 'interrupting', 'cancelling', 'cancelled', 'initializing'],
  thinking_deeply:    ['idle', 'ready', 'busy', 'waiting_for_input', 'error', 'processing', 'interrupting', 'cancelling', 'cancelled', 'initializing'],
  waiting_for_input:  ['busy', 'idle', 'ready', 'error', 'interrupting', 'cancelled', 'initializing'],
  waiting_for_permission: ['busy', 'idle', 'ready', 'waiting_for_input', 'error', 'interrupting', 'cancelling', 'cancelled', 'initializing'],
  interrupting:       ['cancelling', 'interrupt-escalating', 'respawning', 'idle', 'ready', 'cancelled', 'error'],
  cancelling:         ['idle', 'ready', 'cancelled', 'interrupt-escalating', 'error'],
  'interrupt-escalating': ['cancelled', 'respawning', 'error', 'terminated'],
  cancelled:          ['idle', 'ready', 'respawning', 'initializing', 'error', 'superseded'],
  superseded:         ['terminated'],
  respawning:         ['ready', 'idle', 'busy', 'error', 'initializing', 'interrupt-escalating', 'cancelled'],
  hibernating:        ['hibernated'],
  hibernated:         ['waking'],
  waking:             ['ready', 'error'],
  error:              ['ready', 'idle', 'respawning', 'initializing', 'cancelled'],
  degraded:           ['ready', 'idle', 'error', 'initializing'],  // Reconnected → ready/idle, grace period expired → error
  // Terminal states have no outgoing transitions.
  failed:             [],
  terminated:         [],
};

/**
 * InstanceStateMachine enforces valid lifecycle transitions for a single instance.
 *
 * Usage:
 *   const sm = new InstanceStateMachine('initializing');
 *   sm.transition('ready');   // ok
 *   sm.transition('busy');    // ok
 *   sm.transition('ready');   // throws InvalidTransitionError (busy → ready not in map... wait, it is)
 */
export class InstanceStateMachine {
  private _current: InstanceStatus;

  constructor(initial: InstanceStatus = 'initializing') {
    this._current = initial;
  }

  get current(): InstanceStatus {
    return this._current;
  }

  /**
   * Returns true if a transition from the current state to `next` is allowed.
   * Does not mutate state.
   */
  canTransition(next: InstanceStatus): boolean {
    if (TERMINAL_STATES.has(this._current)) {
      return false;
    }
    if (UNIVERSAL_TARGETS.has(next)) {
      return true;
    }
    return (TRANSITION_MAP[this._current] as readonly InstanceStatus[]).includes(next);
  }

  /**
   * Transitions to `next` state.
   * Throws `IllegalTransitionError` if the transition is not permitted.
   */
  transition(next: InstanceStatus): void {
    if (!this.canTransition(next)) {
      throw new InvalidTransitionError(this._current, next);
    }
    this._current = next;
  }
}
