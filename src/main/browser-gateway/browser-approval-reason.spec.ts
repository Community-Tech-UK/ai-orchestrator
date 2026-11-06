import { describe, expect, it } from 'vitest';
import { MAX_STATED_REASON_LENGTH, statedReason } from './browser-approval-reason';

describe('statedReason', () => {
  it.each([undefined, null, 42, {}, '', '   ', '\n\t '])('has nothing to show for %j', (value) => {
    expect(statedReason(value)).toBeUndefined();
  });

  it('keeps the agent’s words, tidied onto one line', () => {
    expect(statedReason('  Placing the order\nyou asked for.\t')).toBe('Placing the order you asked for.');
  });

  it('removes characters that can disguise what a sentence says', () => {
    // Right-to-left override and zero-width space: both can make text read
    // differently from what it is.
    expect(statedReason('Cancel‮ the order​ now')).toBe('Cancel the order now');
  });

  it('redacts anything that looks like a secret', () => {
    const text = statedReason('Sign in with password=PLACEHOLDER then continue') ?? '';
    expect(text).not.toContain('PLACEHOLDER');
    expect(text).toContain('[REDACTED]');
  });

  it('cuts a very long reason instead of filling the card', () => {
    const text = statedReason('a'.repeat(MAX_STATED_REASON_LENGTH + 100)) ?? '';
    expect(text).toHaveLength(MAX_STATED_REASON_LENGTH);
    expect(text.endsWith('…')).toBe(true);
  });

  it('leaves a reason at the limit alone', () => {
    const exact = 'b'.repeat(MAX_STATED_REASON_LENGTH);
    expect(statedReason(exact)).toBe(exact);
  });
});
