import { describe, expect, it } from 'vitest';
import {
  describeRequestOutcome,
  describeUserChoice,
  isRequestOutcomeReason,
  outcomeReasonForStatus,
  previewAnswer,
  statusClearsOpenRequests,
} from './request-outcome';

describe('describeRequestOutcome', () => {
  it('says how long nobody answered, and that nothing ran, for an approval', () => {
    expect(describeRequestOutcome('timeout', { permission: true, waitedMs: 300_000 }).text)
      .toBe('No answer in 5 minutes; nothing ran');
    expect(describeRequestOutcome('timeout', { permission: true, waitedMs: 60_000 }).text)
      .toBe('No answer in 1 minute; nothing ran');
  });

  it('reports the measured wait, not a fixed five minutes', () => {
    expect(describeRequestOutcome('timeout', { permission: true, waitedMs: 59_900 }).text)
      .toBe('No answer in 1 minute; nothing ran');
    expect(describeRequestOutcome('timeout', { permission: true, waitedMs: 12_000 }).text)
      .toBe('No answer in time; nothing ran');
    expect(describeRequestOutcome('timeout', { permission: true }).text)
      .toBe('No answer in time; nothing ran');
  });

  it('does not claim a question "ran" anything', () => {
    expect(describeRequestOutcome('timeout', { permission: false, waitedMs: 300_000 }).text)
      .toBe('No answer in 5 minutes; the question was dropped');
  });

  it.each([
    ['decided', 'Answered elsewhere'],
    ['cancelled', 'Cancelled when the session was stopped'],
    ['exited', 'Cancelled when the session closed'],
    ['auto_approved', 'Allowed automatically'],
  ] as const)('words %s plainly', (reason, text) => {
    expect(describeRequestOutcome(reason, { permission: true }).text).toBe(text);
  });

  it('names the tool separately so the sentence itself stays fixed', () => {
    const words = describeRequestOutcome('decided', { permission: true, tool: 'Bash' });
    expect(words).toEqual({ text: 'Answered elsewhere', subject: 'Bash' });
    expect(describeRequestOutcome('decided', { permission: true }).subject).toBeUndefined();
  });
});

describe('describeUserChoice', () => {
  it('says what the user allowed and for how long', () => {
    expect(describeUserChoice({ kind: 'allowed', scope: 'once', tool: 'Bash' }).text).toBe('You allowed once: Bash');
    expect(describeUserChoice({ kind: 'allowed', scope: 'session', tool: 'Bash' }).text)
      .toBe('You allowed for this session: Bash');
    expect(describeUserChoice({ kind: 'allowed', scope: 'always', tool: 'Bash' }).text).toBe('You always allowed: Bash');
    expect(describeUserChoice({ kind: 'allowed', scope: 'once' }).text).toBe('You allowed once');
  });

  it('says no, and acknowledging a notice is not saying no', () => {
    expect(describeUserChoice({ kind: 'denied', tool: 'Bash' }).text).toBe('You said no: Bash');
    expect(describeUserChoice({ kind: 'denied' }).text).toBe('You said no');
    expect(describeUserChoice({ kind: 'dismissed', tool: 'WebFetch' }).text).toBe('You dismissed: WebFetch');
  });

  it('quotes the first 60 characters of an answer', () => {
    expect(describeUserChoice({ kind: 'answered', answer: 'Bun' }).text).toBe('You answered: Bun');
    const long = 'a'.repeat(61);
    expect(describeUserChoice({ kind: 'answered', answer: long }).text).toBe(`You answered: ${'a'.repeat(60)}…`);
  });

  it('covers skipping and choosing', () => {
    expect(describeUserChoice({ kind: 'skipped' }).text).toBe('You skipped the question');
    expect(describeUserChoice({ kind: 'chose', label: 'Allow once' }).text).toBe('You chose: Allow once');
    expect(describeUserChoice({ kind: 'approved', what: 'Switch to Plan Mode' }).text)
      .toBe('You approved: Switch to Plan Mode');
    expect(describeUserChoice({ kind: 'declined', what: 'Switch to Plan Mode' }).text)
      .toBe('You said no: Switch to Plan Mode');
    expect(describeUserChoice({ kind: 'auto-approve' }).text).toBe('You switched on auto-approve');
  });

  it('says a secret was saved, naming what it was but never a value', () => {
    expect(describeUserChoice({ kind: 'saved', what: 'GitHub personal access token' }).text)
      .toBe('You saved: GitHub personal access token');
  });
});

describe('previewAnswer', () => {
  it('keeps exactly 60 characters without an ellipsis', () => {
    expect(previewAnswer('b'.repeat(60))).toBe('b'.repeat(60));
  });

  it('folds line breaks and runs of spaces into single spaces', () => {
    expect(previewAnswer('  one\n\ntwo   three ')).toBe('one two three');
  });

  it('never splits a character that takes two code units', () => {
    const text = '😀'.repeat(61);
    const preview = previewAnswer(text);
    expect(Array.from(preview.replace('…', ''))).toHaveLength(60);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('isRequestOutcomeReason', () => {
  it('accepts the reasons a request can close with and nothing else', () => {
    for (const reason of ['timeout', 'auto_approved', 'decided', 'cancelled', 'exited']) {
      expect(isRequestOutcomeReason(reason)).toBe(true);
    }
    for (const other of ['expired', '', undefined, null, 5, {}]) {
      expect(isRequestOutcomeReason(other)).toBe(false);
    }
  });
});

describe('statusClearsOpenRequests', () => {
  it.each([
    'terminated', 'failed', 'error', 'cancelled', 'hibernated', 'initializing', 'respawning',
    'interrupting', 'cancelling', 'interrupt-escalating', 'waking',
  ])('clears open requests when the session is %s', (status) => {
    expect(statusClearsOpenRequests(status)).toBe(true);
  });

  it.each(['busy', 'idle', 'processing', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission', 'ready'])(
    'leaves open requests alone when the session is %s',
    (status) => {
      expect(statusClearsOpenRequests(status)).toBe(false);
    },
  );

  it('leaves them alone when there is no status', () => {
    expect(statusClearsOpenRequests(undefined)).toBe(false);
  });
});

describe('outcomeReasonForStatus', () => {
  it('treats a gone process as the session closing', () => {
    for (const status of ['terminated', 'failed', 'error', 'cancelled', 'hibernated', 'respawning', 'initializing', 'waking']) {
      expect(outcomeReasonForStatus(status)).toBe('exited');
    }
  });

  it('treats a stop as the turn being stopped', () => {
    for (const status of ['interrupting', 'cancelling', 'interrupt-escalating']) {
      expect(outcomeReasonForStatus(status)).toBe('cancelled');
    }
  });
});
