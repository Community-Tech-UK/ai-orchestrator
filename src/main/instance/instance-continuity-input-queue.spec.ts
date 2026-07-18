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
    expect(queue.consume('instance-1', 'Next context')).toBe('Next context');
  });

  it('isolates and cleans up pending input by instance', () => {
    queue.queueContinuity('instance-1', 'One');
    queue.queueContinuity('instance-2', 'Two');
    queue.queueContextWarning('instance-1', 'Warning');

    queue.cleanup('instance-1');

    expect(queue.consume('instance-1', undefined)).toBeUndefined();
    expect(queue.consume('instance-2', undefined)).toBe('Two');
  });
});
