import { describe, expect, it } from 'vitest';
import { readClaudeResultStop, resultMetadata } from './claude-result-stop';
// Hand-built documented result-frame shapes; a live capped call remains external validation.
describe('Claude result stop metadata', () => {
  it.each([
    [{ terminal_reason: 'max_turns', subtype: 'success', num_turns: 30 }, 'max_turns'],
    [{ subtype: 'error_max_turns' }, 'max_turns'],
    [{ errors: ['Reached maximum number of turns (30)'] }, 'max_turns'],
    [{ subtype: 'error_max_budget_usd' }, 'budget_exhausted'],
    [{ stop_reason: 'end_turn' }, 'end_turn'],
    [{ terminal_reason: 'hook_stopped' }, 'hook_stopped'],
  ])('reads stop signals %j', (fields, expected) => {
    expect(readClaudeResultStop({ type: 'result', ...fields })?.finishReason).toBe(expected);
  });
  it('keeps unknown stops unrecorded and does not consume non-result frames', () => {
    expect(readClaudeResultStop({ type: 'result' })).toBeUndefined();
    expect(readClaudeResultStop({ type: 'assistant', stop_reason: 'end_turn' })).toBeUndefined();
  });
  it('retains quota alongside a stop reason', () => {
    const quota = { exhausted: true };
    expect(resultMetadata(quota, { finishReason: 'max_turns' })).toEqual({ metadata: { quota, finishReason: 'max_turns', claudeResult: { finishReason: 'max_turns' } } });
  });
});
