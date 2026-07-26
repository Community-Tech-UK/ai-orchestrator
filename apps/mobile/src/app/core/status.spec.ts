import { describe, expect, it } from 'vitest';
import {
  displayStatusColor,
  displayStatusLabel,
  isActiveSessionStatus,
  isInterruptRecovery,
  isLiveActivityCandidate,
  isWorkingOrLooping,
  liveActivityStatusLabel,
} from './status';

describe('desktop-aligned active session status', () => {
  it('includes current live states and excludes terminal, error, and hibernated states', () => {
    const activeStatuses = [
      'initializing',
      'ready',
      'idle',
      'busy',
      'processing',
      'thinking_deeply',
      'waiting_for_input',
      'waiting_for_permission',
      'interrupting',
      'cancelling',
      'interrupt-escalating',
      'respawning',
      'hibernating',
      'waking',
      'degraded',
    ];
    const inactiveStatuses = [
      'cancelled',
      'superseded',
      'hibernated',
      'error',
      'failed',
      'terminated',
    ];

    expect(activeStatuses.map((status) => isActiveSessionStatus(status))).toEqual(
      activeStatuses.map(() => true),
    );
    expect(inactiveStatuses.map((status) => isActiveSessionStatus(status))).toEqual(
      inactiveStatuses.map(() => false),
    );
  });
});

describe('loop-aware session status display', () => {
  it('treats idle looping sessions as active loop sessions', () => {
    const session = { status: 'idle', isLooping: true };

    expect(displayStatusLabel(session)).toBe('loop');
    expect(displayStatusColor(session)).toBe('#a78bfa');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('looping');
  });

  it('keeps attention states ahead of loop state', () => {
    const session = { status: 'waiting_for_permission', isLooping: true };

    expect(displayStatusLabel(session)).toBe('waiting for permission');
    expect(displayStatusColor(session)).toBe('var(--accent-attention)');
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('needs approval');
  });

  it('keeps normal working sessions active without a loop flag', () => {
    const session = { status: 'busy' };

    expect(displayStatusLabel(session)).toBe('busy');
    expect(displayStatusColor(session)).toBe('var(--accent-action)');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('working');
  });
});

describe('interrupt recovery', () => {
  it('flags the statuses where a second stop would cancel the session', () => {
    for (const status of ['respawning', 'interrupting', 'cancelling', 'interrupt-escalating']) {
      expect(isInterruptRecovery(status)).toBe(true);
    }
  });

  it('leaves a normal running turn interruptible', () => {
    for (const status of ['busy', 'processing', 'thinking_deeply', 'idle', '']) {
      expect(isInterruptRecovery(status)).toBe(false);
    }
  });
});
