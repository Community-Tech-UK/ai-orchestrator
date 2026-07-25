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
});
