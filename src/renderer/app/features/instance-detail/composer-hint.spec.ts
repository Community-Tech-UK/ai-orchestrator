import { describe, expect, it } from 'vitest';
import { composerHintFor } from './composer-hint';
describe('single composer hint', () => {
  it.each([
    [{ suggestion: true, busy: true }, 'Tab or → to accept suggestion'],
    [{ loopStarting: true }, 'Starting loop...'],
    [{ loopArmed: true }, 'Enter to start loop, Shift+Enter for new line'],
    [{ starting: true }, 'Starting up... Enter to queue, Shift+Enter for new line'],
    [{ recovering: true }, 'Recovering session... Enter to send after interrupt, Shift+Enter for new line'],
    [{ compacting: true, busy: true }, 'Compacting the conversation… your message will send afterwards'],
    [{ busy: true }, 'Enter queues your message. Esc stops it without sending.'],
    [{ condensed: true }, 'Condensed context will attach when you send.'],
    [{}, 'Enter sends. Shift+Enter adds a line. / opens commands.'],
  ])('chooses one line for %j', (state, expected) => { const text = composerHintFor(state); expect(text).toBe(expected); expect(text).not.toContain('\n'); });
});
