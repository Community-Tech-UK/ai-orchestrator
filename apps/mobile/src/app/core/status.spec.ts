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
  statusColor,
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

    expect(displayStatusLabel(session)).toBe('Loop running');
    expect(displayStatusColor(session)).toBe('#a78bfa');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('looping');
  });

  it('keeps attention states ahead of loop state', () => {
    const session = { status: 'waiting_for_permission', isLooping: true };

    expect(displayStatusLabel(session)).toBe('Needs your OK');
    expect(displayStatusColor(session)).toBe('#f59e0b');
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('needs approval');
  });

  it('keeps normal working sessions active without a loop flag', () => {
    const session = { status: 'busy' };

    expect(displayStatusLabel(session)).toBe('Working');
    expect(displayStatusColor(session)).toBe('#3b82f6');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('working');
  });
});

describe('lock-screen key for a session that is waiting on you', () => {
  it('sends a question as waiting, not as needs approval', () => {
    const session = { status: 'waiting_for_input' };

    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('waiting');
  });

  it('keeps a permission prompt as needs approval, including while a loop runs', () => {
    expect(liveActivityStatusLabel({ status: 'waiting_for_permission' })).toBe('needs approval');
    expect(liveActivityStatusLabel({ status: 'waiting_for_permission', isLooping: true })).toBe('needs approval');
    expect(liveActivityStatusLabel({ status: 'waiting_for_input', isLooping: true })).toBe('waiting');
  });
});

describe('colours follow the desktop status tones', () => {
  it('draws a forced stop in the error colour and a stop in progress in the working colour', () => {
    expect(statusColor('interrupt-escalating')).toBe('#ef4444');
    expect(statusColor('cancelling')).toBe('#b89a66');
    expect(statusColor('interrupting')).toBe('#b89a66');
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
