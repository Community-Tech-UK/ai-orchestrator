import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  buildReplayContinuityMessage,
  truncateTranscriptContent,
} from './replay-continuity';

function message(id: string, type: OutputMessage['type'], content: string): OutputMessage {
  return { id, type, content, timestamp: 1_000 } as OutputMessage;
}

describe('truncateTranscriptContent', () => {
  it('returns short content untouched', () => {
    expect(truncateTranscriptContent('  hello\r\nworld  ', 100)).toBe('hello\nworld');
  });

  it('keeps both ends of over-long content', () => {
    const value = `START${'x'.repeat(500)}END`;

    const truncated = truncateTranscriptContent(value, 100);

    expect(truncated.startsWith('START')).toBe(true);
    expect(truncated.endsWith('END')).toBe(true);
    expect(truncated).toContain('[truncated]');
    expect(truncated.length).toBeLessThan(value.length);
  });
});

describe('buildReplayContinuityMessage', () => {
  const pendingQuestion = [
    'Nearest Meetings is fully implemented and committed on `feat/nearest-meetings`.',
    'filler '.repeat(200),
    'Implementation complete. What would you like to do?',
    '1. Merge back to `main` locally',
    '2. Push and create a Pull Request',
    "3. Keep the branch as-is (I'll handle it later)",
    'Which option?',
  ].join('\n');

  it('preserves the pending options at the end of the final turn', () => {
    // The next user message is "1", so losing this tail forces the agent to ask
    // the user what they meant (2026-07-25 restore incident).
    const preamble = buildReplayContinuityMessage(
      [
        message('u1', 'user', 'Build the nearest-meetings feature'),
        message('a1', 'assistant', pendingQuestion),
      ],
      { reason: 'history-restore-fallback' },
    );

    expect(preamble).toContain('1. Merge back to `main` locally');
    expect(preamble).toContain('Which option?');
  });

  it('gives the final turn a larger budget than earlier turns', () => {
    const earlier = `EARLIER-HEAD${'y'.repeat(2_000)}EARLIER-TAIL`;
    const preamble = buildReplayContinuityMessage(
      [
        message('u1', 'user', 'Start'),
        message('a1', 'assistant', earlier),
        message('a2', 'assistant', pendingQuestion),
      ],
      { reason: 'history-restore-fallback' },
    ) as string;

    // Earlier turns still get squeezed to the per-message budget...
    expect(preamble).toContain('EARLIER-HEAD');
    expect(preamble).toContain('...[truncated]...');
    // ...while the newest turn survives whole.
    expect(preamble).toContain(pendingQuestion.split('\n').slice(-4).join('\n'));
  });

  it('returns null when there are no conversational turns', () => {
    expect(
      buildReplayContinuityMessage([message('s1', 'system', 'noise')], { reason: 'x' }),
    ).toBeNull();
  });

  describe('original request anchor', () => {
    it('keeps the opening prompt when it falls outside the scrollback window', () => {
      const opening = 'Migrate the billing service off the legacy gateway.';
      const turns = [
        message('u0', 'user', opening),
        ...Array.from({ length: 60 }, (_, index) =>
          message(`a${index}`, 'assistant', `step ${index}`)),
        message('u-last', 'user', 'carry on'),
      ];

      const preamble = buildReplayContinuityMessage(turns, {
        reason: 'provider-change',
        maxTurns: 4,
      }) as string;

      // The window genuinely excluded it...
      expect(preamble).toContain('earlier turns omitted for brevity');
      // ...but the task itself still survives.
      expect(preamble).toContain('Original request:');
      expect(preamble).toContain(opening);
    });

    it('omits the anchor when the opening prompt is the current objective', () => {
      const preamble = buildReplayContinuityMessage(
        [message('u0', 'user', 'only ever asked this')],
        { reason: 'provider-change' },
      ) as string;

      expect(preamble).not.toContain('Original request:');
    });

    it('gives the opening prompt the larger budget rather than the scrollback one', () => {
      // Longer than the scrollback budget, shorter than the last-turn budget,
      // so only the anchor can reproduce it whole.
      const opening = `OPENING-HEAD${'z'.repeat(2_000)}OPENING-TAIL`;
      const preamble = buildReplayContinuityMessage(
        [
          message('u0', 'user', opening),
          message('a0', 'assistant', 'working'),
          message('u1', 'user', 'continue'),
        ],
        { reason: 'provider-change', maxCharsPerMessage: 200, maxCharsForLastTurn: 4_000 },
      ) as string;

      expect(preamble).toContain(`Original request:\n${opening}`);
    });
  });
});
