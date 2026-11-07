import { describe, expect, it } from 'vitest';
import { presentSendFailure, sendRefusedText } from './user-message';
import { getRetryDisposition } from '../../renderer/app/core/state/instance/messaging-retry-disposition';

describe('send failure copy', () => {
  const timeout = 'Send input timed out after 60s. The app cleared the optimistic busy state; please retry after checking the session.';
  it('translates the timeout without changing the retry classifier input', () => {
    expect(presentSendFailure(timeout)).toBe("Your message didn't reach the session within 60s. Check the session is running, then send it again.");
    expect(getRetryDisposition('busy', timeout)).toEqual({ shouldRetry: false, nextStatus: 'idle' });
  });
  it('recognises the pause code first and old stored pause messages', () => {
    const expected = 'Harness is paused, so nothing was sent. Resume Harness, then send again.';
    expect(presentSendFailure('Different raw diagnostic', 'ORCHESTRATOR_PAUSED')).toBe(expected);
    expect(presentSendFailure('Orchestrator is paused')).toBe(expected);
    expect(presentSendFailure('Message refused while orchestrator is paused')).toBe(expected);
    expect(presentSendFailure('Unknown reason')).toBe("Your message wasn't sent.");
  });
  it('uses the shared status words in send refusals', () => {
    expect(sendRefusedText('send', 'failed')).toBe("This session has failed, so your message wasn't sent. Restart the session to continue.");
    expect(sendRefusedText('steer', 'terminated')).toContain('closed');
    expect(sendRefusedText('steer-queued', 'superseded')).not.toMatch(/superseded|instance/);
    expect(sendRefusedText('steer', 'cancelled')).toContain('was stopped');
  });
});
