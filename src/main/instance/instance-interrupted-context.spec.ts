import { afterEach, describe, expect, it } from 'vitest';
import { getInterruptedContextQueue, InterruptedContextQueue } from './instance-interrupted-context';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';

describe('interrupted context alongside existing recovery', () => {
  afterEach(() => InterruptedContextQueue._resetForTesting());

  it('preserves both a queued replay context and the new interrupted context until dispatch commits', () => {
    const continuity = new InstanceContinuityInputQueue();
    continuity.queueContinuity('session', 'SAVED_RECOVERY_CONTEXT', { userOnly: false });
    getInterruptedContextQueue().queue('session', 'INTERRUPTED_CONTEXT');
    const prepared = continuity.prepare('session', 'CURRENT_CONTEXT');
    expect(prepared.contextBlock).toBe('SAVED_RECOVERY_CONTEXT\n\nINTERRUPTED_CONTEXT\n\nCURRENT_CONTEXT');
    expect(continuity.prepare('session', null).contextBlock).toContain('SAVED_RECOVERY_CONTEXT');
    prepared.commit();
    expect(continuity.prepare('session', null).contextBlock).toBe('SAVED_RECOVERY_CONTEXT');
    continuity.markAnswered('session');
    expect(continuity.prepare('session', null).contextBlock).toBeNull();
  });

  it('does not consume a newer continuation when an older in-flight send commits', () => {
    const continuity = new InstanceContinuityInputQueue();
    getInterruptedContextQueue().queue('session', 'OLD_CONTEXT');
    const old = continuity.prepare('session', null);
    getInterruptedContextQueue().queue('session', 'NEW_CONTEXT');
    old.commit();
    expect(continuity.prepare('session', null).contextBlock).toBe('NEW_CONTEXT');
  });

  it('holds a stop note apart from Continue context: neither replaces the other, and one commit sends both', () => {
    const continuity = new InstanceContinuityInputQueue();
    const queue = getInterruptedContextQueue();
    queue.queueStopNote('session', 'STOP_NOTE');
    queue.queue('session', 'CONTINUE_CONTEXT');
    const prepared = continuity.prepare('session', 'CURRENT_CONTEXT');
    expect(prepared.contextBlock).toBe('STOP_NOTE\n\nCONTINUE_CONTEXT\n\nCURRENT_CONTEXT');
    queue.queueStopNote('session', 'NEWER_NOTE');
    prepared.commit();
    // The newer note was queued while the older one was being sent, so it stays.
    expect(continuity.prepare('session', null).contextBlock).toBe('NEWER_NOTE');
  });

  it('cleans up the extra context with the owning session', () => {
    const continuity = new InstanceContinuityInputQueue();
    getInterruptedContextQueue().queue('session', 'INTERRUPTED_CONTEXT');
    getInterruptedContextQueue().queueStopNote('session', 'STOP_NOTE');
    continuity.cleanup('session');
    expect(continuity.prepare('session', null).contextBlock).toBeNull();
  });

  it('cannot discard a newer continuation when an older send is rejected', () => {
    const queue = getInterruptedContextQueue();
    const discardOld = queue.queue('session', 'OLD_CONTEXT');
    queue.queue('session', 'NEW_CONTEXT');
    discardOld?.();
    expect(queue.prepare('session').value).toBe('NEW_CONTEXT');
  });
});
