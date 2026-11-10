import { describe, expect, it } from 'vitest';
import { USAGE_CAUSE_TOOLTIPS } from '../../../../shared/usage-insight/usage-cause-copy';
import { CACHE_MISS_TOKENS, LONG_CONTEXT_TOKENS } from '../../../../shared/usage-insight/usage-cause-rules';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import { contextSizeAdvice } from './context-size-advice';

const LONG_CHAT = USAGE_CAUSE_TOOLTIPS.contextRing;
const COMING_BACK = USAGE_CAUSE_TOOLTIPS.contextRingIdle;

describe('contextSizeAdvice', () => {
  it.each<[string, number, InstanceStatus | undefined, string | null]>([
    ['a long chat that is working', LONG_CONTEXT_TOKENS + 1, 'busy', LONG_CHAT],
    ['a long chat of unknown status', LONG_CONTEXT_TOKENS + 1, undefined, LONG_CHAT],
    ['a long chat at rest: coming back is the more useful thing to say', LONG_CONTEXT_TOKENS + 1, 'idle', COMING_BACK],
    ['a big chat at rest', CACHE_MISS_TOKENS + 1, 'ready', COMING_BACK],
    ['a big chat waiting for an answer', CACHE_MISS_TOKENS + 1, 'waiting_for_input', COMING_BACK],
    ['a big chat that is working: not long enough for the long-chat sentence', CACHE_MISS_TOKENS + 1, 'busy', null],
    ['a small chat at rest', CACHE_MISS_TOKENS - 1, 'idle', null],
    ['a chat exactly on the coming-back size (the card counts only above it)', CACHE_MISS_TOKENS, 'idle', null],
    ['a chat exactly on the long-chat size (the card counts only above it)', LONG_CONTEXT_TOKENS, 'busy', null],
  ])('Claude, %s', (_label, tokens, status, expected) => {
    expect(contextSizeAdvice({ provider: 'claude', tokens, status })).toBe(expected);
  });

  it.each(['codex', undefined, null])(
    'says nothing on a %s session, whatever its size',
    (provider) => {
      expect(contextSizeAdvice({ provider, tokens: LONG_CONTEXT_TOKENS * 2, status: 'idle' })).toBeNull();
      expect(contextSizeAdvice({ provider, tokens: LONG_CONTEXT_TOKENS * 2, status: 'busy' })).toBeNull();
    },
  );

  it('says nothing while the size has not been measured', () => {
    expect(contextSizeAdvice({ provider: 'claude', tokens: undefined, status: 'idle' })).toBeNull();
  });
});
