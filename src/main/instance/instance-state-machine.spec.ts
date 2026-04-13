import { describe, it, expect } from 'vitest';
import { InstanceStateMachine, InvalidTransitionError } from './instance-state-machine';
import type { InstanceStatus } from '../../shared/types/instance.types';

// ---------------------------------------------------------------------------
// InvalidTransitionError
// ---------------------------------------------------------------------------

describe('InvalidTransitionError', () => {
  it('has name "InvalidTransitionError"', () => {
    const err = new InvalidTransitionError('idle', 'busy');
    expect(err.name).toBe('InvalidTransitionError');
  });

  it('includes both states in the message', () => {
    const err = new InvalidTransitionError('hibernated', 'idle');
    expect(err.message).toContain('hibernated');
    expect(err.message).toContain('idle');
  });

  it('is an instance of Error', () => {
    const err = new InvalidTransitionError('ready', 'waking');
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – constructor', () => {
  it('defaults initial state to "initializing"', () => {
    const sm = new InstanceStateMachine();
    expect(sm.current).toBe('initializing');
  });

  it('accepts an explicit initial state', () => {
    const sm = new InstanceStateMachine('idle');
    expect(sm.current).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – valid transitions', () => {
  it('initializing → ready', () => {
    const sm = new InstanceStateMachine('initializing');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('initializing → error', () => {
    const sm = new InstanceStateMachine('initializing');
    sm.transition('error');
    expect(sm.current).toBe('error');
  });

  it('initializing → idle', () => {
    // Some CLI adapters emit their first idle event before any explicit
    // 'ready' transition — treat that as a valid startup path.
    const sm = new InstanceStateMachine('initializing');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('ready → busy → idle', () => {
    const sm = new InstanceStateMachine('ready');
    sm.transition('busy');
    expect(sm.current).toBe('busy');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('ready → idle', () => {
    const sm = new InstanceStateMachine('ready');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('ready → hibernating', () => {
    const sm = new InstanceStateMachine('ready');
    sm.transition('hibernating');
    expect(sm.current).toBe('hibernating');
  });

  it('busy → waiting_for_input', () => {
    const sm = new InstanceStateMachine('busy');
    sm.transition('waiting_for_input');
    expect(sm.current).toBe('waiting_for_input');
  });

  it('busy → ready', () => {
    const sm = new InstanceStateMachine('busy');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('busy → error', () => {
    const sm = new InstanceStateMachine('busy');
    sm.transition('error');
    expect(sm.current).toBe('error');
  });

  it('waiting_for_input → busy', () => {
    const sm = new InstanceStateMachine('waiting_for_input');
    sm.transition('busy');
    expect(sm.current).toBe('busy');
  });

  it('waiting_for_input → idle', () => {
    const sm = new InstanceStateMachine('waiting_for_input');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('waiting_for_input → ready', () => {
    const sm = new InstanceStateMachine('waiting_for_input');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('error → ready', () => {
    const sm = new InstanceStateMachine('error');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('error → idle', () => {
    const sm = new InstanceStateMachine('error');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('error → respawning', () => {
    const sm = new InstanceStateMachine('error');
    sm.transition('respawning');
    expect(sm.current).toBe('respawning');
  });

  it('respawning → ready', () => {
    const sm = new InstanceStateMachine('respawning');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('respawning → idle', () => {
    const sm = new InstanceStateMachine('respawning');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('respawning → error', () => {
    const sm = new InstanceStateMachine('respawning');
    sm.transition('error');
    expect(sm.current).toBe('error');
  });

  it('full hibernation cycle: idle → hibernating → hibernated → waking → ready', () => {
    const sm = new InstanceStateMachine('idle');
    sm.transition('hibernating');
    expect(sm.current).toBe('hibernating');
    sm.transition('hibernated');
    expect(sm.current).toBe('hibernated');
    sm.transition('waking');
    expect(sm.current).toBe('waking');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('waking → error', () => {
    const sm = new InstanceStateMachine('waking');
    sm.transition('error');
    expect(sm.current).toBe('error');
  });

  it('idle → waiting_for_input', () => {
    const sm = new InstanceStateMachine('idle');
    sm.transition('waiting_for_input');
    expect(sm.current).toBe('waiting_for_input');
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – invalid transitions', () => {
  it('idle → busy is not allowed', () => {
    const sm = new InstanceStateMachine('idle');
    expect(() => sm.transition('busy')).toThrow(InvalidTransitionError);
    // State must not have changed
    expect(sm.current).toBe('idle');
  });

  it('hibernated → idle is not allowed (must go through waking)', () => {
    const sm = new InstanceStateMachine('hibernated');
    expect(() => sm.transition('idle')).toThrow(InvalidTransitionError);
    expect(sm.current).toBe('hibernated');
  });

  it('hibernated → ready is not allowed (must go through waking)', () => {
    const sm = new InstanceStateMachine('hibernated');
    expect(() => sm.transition('ready')).toThrow(InvalidTransitionError);
    expect(sm.current).toBe('hibernated');
  });

  it('initializing → busy is not allowed', () => {
    const sm = new InstanceStateMachine('initializing');
    expect(() => sm.transition('busy')).toThrow(InvalidTransitionError);
  });

  it('ready → error is not allowed', () => {
    const sm = new InstanceStateMachine('ready');
    expect(() => sm.transition('error')).toThrow(InvalidTransitionError);
  });

  it('waking → busy is not allowed', () => {
    const sm = new InstanceStateMachine('waking');
    expect(() => sm.transition('busy')).toThrow(InvalidTransitionError);
  });

  it('hibernating → ready is not allowed (must finish hibernating first)', () => {
    const sm = new InstanceStateMachine('hibernating');
    expect(() => sm.transition('ready')).toThrow(InvalidTransitionError);
  });

  it('error → busy is not allowed', () => {
    const sm = new InstanceStateMachine('error');
    expect(() => sm.transition('busy')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Universal targets: terminated and failed reachable from any non-terminal
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – universal targets (terminated / failed)', () => {
  const nonTerminalStates: InstanceStatus[] = [
    'initializing',
    'ready',
    'idle',
    'busy',
    'waiting_for_input',
    'respawning',
    'hibernating',
    'hibernated',
    'waking',
    'error',
  ];

  for (const source of nonTerminalStates) {
    it(`${source} → terminated`, () => {
      const sm = new InstanceStateMachine(source);
      sm.transition('terminated');
      expect(sm.current).toBe('terminated');
    });

    it(`${source} → failed`, () => {
      const sm = new InstanceStateMachine(source);
      sm.transition('failed');
      expect(sm.current).toBe('failed');
    });
  }
});

// ---------------------------------------------------------------------------
// Terminal states: no outgoing transitions
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – terminal states', () => {
  it('no transitions allowed from terminated', () => {
    const sm = new InstanceStateMachine('terminated');
    const targets: InstanceStatus[] = ['ready', 'idle', 'error', 'failed', 'initializing'];
    for (const target of targets) {
      expect(() => sm.transition(target)).toThrow(InvalidTransitionError);
      expect(sm.current).toBe('terminated');
    }
  });

  it('no transitions allowed from failed', () => {
    const sm = new InstanceStateMachine('failed');
    const targets: InstanceStatus[] = ['ready', 'idle', 'error', 'terminated', 'initializing'];
    for (const target of targets) {
      expect(() => sm.transition(target)).toThrow(InvalidTransitionError);
      expect(sm.current).toBe('failed');
    }
  });

  it('terminated → terminated is not allowed', () => {
    const sm = new InstanceStateMachine('terminated');
    expect(() => sm.transition('terminated')).toThrow(InvalidTransitionError);
  });

  it('failed → failed is not allowed', () => {
    const sm = new InstanceStateMachine('failed');
    expect(() => sm.transition('failed')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// canTransition() — pure query, no state mutation
// ---------------------------------------------------------------------------

describe('InstanceStateMachine – canTransition()', () => {
  it('returns true for a valid transition', () => {
    const sm = new InstanceStateMachine('ready');
    expect(sm.canTransition('busy')).toBe(true);
  });

  it('returns false for an invalid transition', () => {
    const sm = new InstanceStateMachine('idle');
    expect(sm.canTransition('busy')).toBe(false);
  });

  it('does not mutate state when returning true', () => {
    const sm = new InstanceStateMachine('ready');
    sm.canTransition('busy');
    expect(sm.current).toBe('ready');
  });

  it('does not mutate state when returning false', () => {
    const sm = new InstanceStateMachine('idle');
    sm.canTransition('busy');
    expect(sm.current).toBe('idle');
  });

  it('returns true for universal target (terminated) from any non-terminal state', () => {
    const sm = new InstanceStateMachine('hibernated');
    expect(sm.canTransition('terminated')).toBe(true);
  });

  it('returns true for universal target (failed) from any non-terminal state', () => {
    const sm = new InstanceStateMachine('waking');
    expect(sm.canTransition('failed')).toBe(true);
  });

  it('returns false from terminal state (terminated)', () => {
    const sm = new InstanceStateMachine('terminated');
    expect(sm.canTransition('ready')).toBe(false);
    expect(sm.canTransition('terminated')).toBe(false);
    expect(sm.canTransition('failed')).toBe(false);
  });

  it('returns false from terminal state (failed)', () => {
    const sm = new InstanceStateMachine('failed');
    expect(sm.canTransition('ready')).toBe(false);
    expect(sm.canTransition('terminated')).toBe(false);
    expect(sm.canTransition('failed')).toBe(false);
  });
});
