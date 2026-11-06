import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { REPLAY_DIGEST_MAX_TOKENS } from '../../shared/utils/replay-carryover';
import { buildReplayContinuityMessage } from './replay-continuity';

function message(index: number, type: 'user' | 'assistant', content: string): OutputMessage {
  return { id: `m${index}`, timestamp: index, type, content };
}

describe('the replay digest never outgrows the size the pre-click preview promises', () => {
  it('stays within REPLAY_DIGEST_MAX_TOKENS for a very long, very wordy conversation', () => {
    const messages: OutputMessage[] = [];
    for (let index = 0; index < 120; index++) {
      const todos = Array.from({ length: 8 }, (_, n) => `- [ ] open item ${index}-${n} ${'z'.repeat(1_500)}`).join('\n');
      messages.push(message(index * 2, 'user', `${'q'.repeat(20_000)}\n${todos}`));
      messages.push(message(index * 2 + 1, 'assistant', 'a'.repeat(20_000)));
    }
    const digest = buildReplayContinuityMessage(messages, { reason: 'model-change' });
    expect(digest).not.toBeNull();
    // The preview counts four characters to a token, as the bound itself does.
    expect(Math.ceil(digest!.length / 4)).toBeLessThanOrEqual(REPLAY_DIGEST_MAX_TOKENS);
  });

  it('is much smaller than a large session, which is the loss the preview describes', () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index, index % 2 ? 'assistant' : 'user', 'w'.repeat(10_000)));
    const digest = buildReplayContinuityMessage(messages, { reason: 'model-change' })!;
    const sessionTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    expect(Math.ceil(digest.length / 4)).toBeLessThan(sessionTokens / 20);
  });
});
