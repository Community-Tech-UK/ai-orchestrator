import { describe, expect, it } from 'vitest';
import { formatWaitReasonLabel } from './input-panel-formatters';

describe('held message words', () => {
  it('explains restart without exposing a resume strategy', () => {
    expect(formatWaitReasonLabel({ kind: 'respawning', strategy: 'native-resume', startedAt: 1000 }, 13_000))
      .toBe('Restarting this session and picking up where you left off. Your message will send in a moment. · waiting 12 s');
  });

  it('uses the actual retry deadline and counts down to zero', () => {
    expect(formatWaitReasonLabel({ kind: 'backoff', attempt: 3, retryAt: 25_000 }, 13_000)).toBe('Retrying in 12 s');
    expect(formatWaitReasonLabel({ kind: 'backoff', attempt: 3, retryAt: 25_000 }, 26_000)).toBe('Retrying now…');
  });

  it('explains an interrupt acknowledgement wait without internal jargon', () => {
    expect(formatWaitReasonLabel({ kind: 'interrupt-ack', attempt: 1, startedAt: 1000 }, 13_000))
      .toBe('Waiting for the current work to stop before sending your message. · waiting 12 s');
  });

  it('does not expose an internal mutex operation in the message', () => {
    expect(formatWaitReasonLabel({ kind: 'mutex', operation: 'PRIVATE_INTERNAL_OPERATION', startedAt: 1000 }, 13_000))
      .toBe('Finishing the previous action before sending your message. · waiting 12 s');
  });
});
