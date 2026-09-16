import { describe, expect, it } from 'vitest';
import { InstanceCommunicationOverflowTracker } from './instance-communication-overflow-tracker';

describe('InstanceCommunicationOverflowTracker', () => {
  it('remembers the last sent turn and resume prompt', () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    tracker.rememberLastSent('inst-1', {
      message: 'retry me',
      attachments: [],
      contextBlock: 'ctx',
    });
    expect(tracker.getResumePrompt('inst-1')).toBe('retry me');
    expect(tracker.getLastSent('inst-1')?.contextBlock).toBe('ctx');
  });

  it('tracks warning, retry, and seen flags independently and cleans them up', () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    tracker.markWarning('inst-1');
    tracker.markRetried('inst-1');
    tracker.markSeen('inst-1');
    expect(tracker.hasWarning('inst-1')).toBe(true);
    expect(tracker.hasRetried('inst-1')).toBe(true);
    expect(tracker.hasSeen('inst-1')).toBe(true);

    tracker.clearWarning('inst-1');
    tracker.clearRetry('inst-1');
    expect(tracker.hasWarning('inst-1')).toBe(false);
    expect(tracker.hasRetried('inst-1')).toBe(false);
    expect(tracker.hasSeen('inst-1')).toBe(true);

    tracker.cleanup('inst-1');
    expect(tracker.getLastSent('inst-1')).toBeUndefined();
    expect(tracker.hasSeen('inst-1')).toBe(false);
  });
});
