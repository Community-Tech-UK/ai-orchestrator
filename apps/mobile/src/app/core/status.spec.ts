import { describe, expect, it } from 'vitest';
import {
  displayStatusColor,
  displayStatusLabel,
  isActiveSessionStatus,
  isInterruptRecovery,
  isLiveActivityCandidate,
  isWorkingOrLooping,
  liveActivityStatusLabel,
  loopQuestionKindLabel,
  loopQuestionStatusLabel,
  loopStatusLabel,
} from './status';

describe('desktop-aligned active session status', () => {
  it('includes current live and hibernated states and excludes terminal and error states', () => {
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
      'hibernated',
      'waking',
      'degraded',
    ];
    const inactiveStatuses = [
      'cancelled',
      'superseded',
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

describe('loop status wording (mirrors desktop loopStatusLabel)', () => {
  it('uses the desktop wording for every loop status', () => {
    expect(loopStatusLabel('completed')).toBe('completed');
    expect(loopStatusLabel('completed-needs-review')).toBe('ended, see notes');
    expect(loopStatusLabel('attempt-failed')).toBe('stopped: a step failed');
    expect(loopStatusLabel('cancelled')).toBe('cancelled');
    expect(loopStatusLabel('failed')).toBe('failed');
    expect(loopStatusLabel('cap-reached')).toBe('cap');
    expect(loopStatusLabel('error')).toBe('error');
    expect(loopStatusLabel('no-progress')).toBe('no-progress');
    expect(loopStatusLabel('provider-limit')).toBe('provider limit');
    expect(loopStatusLabel('cost-exceeded')).toBe('cost exceeded');
    expect(loopStatusLabel('needs-human-arbitration')).toBe('needs arbitration');
    expect(loopStatusLabel('reviewer-unreliable')).toBe('reviewer unreliable');
    expect(loopStatusLabel('reviewer-unavailable')).toBe('reviewer unavailable');
    expect(loopStatusLabel('builder-unreliable')).toBe('builder unreliable');
    expect(loopStatusLabel('paused')).toBe('paused');
    expect(loopStatusLabel('running')).toBe('running');
  });

  it('passes an unknown status through unchanged', () => {
    expect(loopStatusLabel('brand-new-state')).toBe('brand-new-state');
  });
});

describe('loop question wording', () => {
  it('names every outstanding kind and status', () => {
    expect(loopQuestionKindLabel('needs-human')).toBe('Waiting for you');
    expect(loopQuestionKindLabel('decision-applied')).toBe('Decision applied, tell me if wrong');
    expect(loopQuestionKindLabel('open-question')).toBe('Open question');
    expect(loopQuestionKindLabel('for-information')).toBe('For information');
    expect(loopQuestionStatusLabel('open')).toBe('Open');
    expect(loopQuestionStatusLabel('resolved')).toBe('Resolved');
    expect(loopQuestionStatusLabel('dismissed')).toBe('Dismissed');
  });
});
