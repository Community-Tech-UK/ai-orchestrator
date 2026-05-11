import { describe, expect, it } from 'vitest';

import { isLoopOriginatedUserMessage } from './loop-message-detection';

describe('isLoopOriginatedUserMessage', () => {
  it('returns true for the loop kickoff prompt', () => {
    expect(
      isLoopOriginatedUserMessage({ type: 'user', metadata: { kind: 'loop-start' } }),
    ).toBe(true);
  });

  it('returns true for mid-loop "Inject hint" nudges', () => {
    expect(
      isLoopOriginatedUserMessage({ type: 'user', metadata: { kind: 'loop-intervene' } }),
    ).toBe(true);
  });

  it('returns false for ordinary user messages with no metadata kind', () => {
    expect(isLoopOriginatedUserMessage({ type: 'user', metadata: undefined })).toBe(false);
    expect(isLoopOriginatedUserMessage({ type: 'user', metadata: {} })).toBe(false);
  });

  it('returns false for unrelated metadata kinds so future loop-adjacent kinds opt in explicitly', () => {
    expect(
      isLoopOriginatedUserMessage({ type: 'user', metadata: { kind: 'cwd-switch' } }),
    ).toBe(false);
    expect(
      isLoopOriginatedUserMessage({ type: 'user', metadata: { kind: 'loop-summary' } }),
    ).toBe(false);
  });

  it('returns false for non-user messages even when the metadata kind matches', () => {
    expect(
      isLoopOriginatedUserMessage({ type: 'system', metadata: { kind: 'loop-start' } }),
    ).toBe(false);
    expect(
      isLoopOriginatedUserMessage({ type: 'assistant', metadata: { kind: 'loop-intervene' } }),
    ).toBe(false);
  });
});
