import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';

describe('InstanceContinuityInputQueue', () => {
  let queue: InstanceContinuityInputQueue;

  beforeEach(() => {
    queue = new InstanceContinuityInputQueue();
  });

  it('ignores blank continuity preambles', () => {
    queue.queueContinuity('instance-1', '   ');

    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('consumes continuity then warning before the caller context block', () => {
    queue.queueContinuity('instance-1', 'Recovered conversation context');
    queue.queueContextWarning('instance-1', 'Context pressure guidance');

    expect(queue.consume('instance-1', 'Caller-provided context')).toBe(
      'Recovered conversation context\n\nContext pressure guidance\n\nCaller-provided context',
    );
    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', 'Next context')).toBe('Next context');
  });

  it('sends continuity again with the next input when the model never replied to it', () => {
    queue.queueContinuity('instance-1', 'Recovered conversation context');
    queue.queueContextWarning('instance-1', 'Context pressure guidance');
    queue.consume('instance-1', null);

    // The turn was stopped before any reply: history again, the warning was one-shot.
    expect(queue.consume('instance-1', 'try again')).toBe('Recovered conversation context\n\ntry again');

    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', 'next')).toBe('next');
  });

  it('holds history delivered outside the queue until the model replies', () => {
    queue.holdUntilAnswered('instance-1', 'Condensed history sent as its own turn');
    queue.queueContinuity('instance-1', 'Late code search results');

    expect(queue.consume('instance-1', 'try again')).toBe(
      'Condensed history sent as its own turn\n\nLate code search results\n\ntry again',
    );
    // Still unanswered: both go out again, once each.
    expect(queue.consume('instance-1', null)).toBe(
      'Condensed history sent as its own turn\n\nLate code search results',
    );

    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('does not repeat held history in a retried turn that already carries it', () => {
    queue.holdUntilAnswered('instance-1', 'Condensed history');
    const firstSend = queue.consume('instance-1', 'context');

    expect(queue.consume('instance-1', firstSend)).toBe(firstSend);
    queue.queueContextWarning('instance-1', 'Warning');
    expect(queue.consume('instance-1', firstSend)).toBe(`Warning\n\n${firstSend}`);
  });

  it('ignores blank held history', () => {
    queue.holdUntilAnswered('instance-1', '  ');

    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('isolates and cleans up pending input by instance', () => {
    queue.queueContinuity('instance-1', 'One');
    queue.queueContinuity('instance-2', 'Two');
    queue.queueContextWarning('instance-1', 'Warning');
    queue.holdUntilAnswered('instance-1', 'Held');

    queue.cleanup('instance-1');

    expect(queue.consume('instance-1', undefined)).toBeUndefined();
    expect(queue.consume('instance-2', undefined)).toBe('Two');
  });
});
