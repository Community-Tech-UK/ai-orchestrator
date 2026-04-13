import type { InstanceStatus } from '../../shared/types/instance.types';

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class InvalidTransitionError extends Error {
  constructor(from: InstanceStatus, to: InstanceStatus) {
    super(`Invalid transition: ${from} → ${to}`);
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
const UNIVERSAL_TARGETS = new Set<InstanceStatus>(['terminated', 'failed', 'degraded']);

/**
 * Explicit allowed transitions (excluding universal targets).
 * Universal targets (terminated, failed) are added dynamically for every
 * non-terminal source state at runtime.
 */
const TRANSITION_MAP: Readonly<Record<InstanceStatus, readonly InstanceStatus[]>> = {
  initializing:       ['ready', 'idle', 'error'],
  ready:              ['busy', 'idle', 'hibernating'],
  idle:               ['ready', 'hibernating', 'waiting_for_input'],
  busy:               ['idle', 'ready', 'waiting_for_input', 'waiting_for_permission', 'error', 'processing', 'thinking_deeply'],
  processing:         ['idle', 'ready', 'busy', 'waiting_for_input', 'error', 'thinking_deeply'],
  thinking_deeply:    ['idle', 'ready', 'busy', 'waiting_for_input', 'error', 'processing'],
  waiting_for_input:  ['busy', 'idle', 'ready'],
  waiting_for_permission: ['busy', 'idle', 'ready', 'waiting_for_input'],
  respawning:         ['ready', 'idle', 'error'],
  hibernating:        ['hibernated'],
  hibernated:         ['waking'],
  waking:             ['ready', 'error'],
  error:              ['ready', 'idle', 'respawning'],
  degraded:           ['ready', 'idle', 'error'],  // Reconnected → ready/idle, grace period expired → error
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
   * Throws `InvalidTransitionError` if the transition is not permitted.
   */
  transition(next: InstanceStatus): void {
    if (!this.canTransition(next)) {
      throw new InvalidTransitionError(this._current, next);
    }
    this._current = next;
  }
}
