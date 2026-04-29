import { describe, expect, it } from 'vitest';

import { shouldCollapseUserMessage } from './output-stream-message-collapse';

describe('shouldCollapseUserMessage', () => {
  it('returns false for non-user messages', () => {
    expect(shouldCollapseUserMessage({ type: 'assistant', content: 'x'.repeat(5000) })).toBe(false);
  });

  it('returns false for short user messages', () => {
    expect(shouldCollapseUserMessage({ type: 'user', content: 'Short message' })).toBe(false);
  });

  it('returns true for long single-line user messages', () => {
    expect(shouldCollapseUserMessage({ type: 'user', content: 'x'.repeat(900) })).toBe(true);
  });

  it('returns true for multi-line user messages above the line threshold', () => {
    const content = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n');
    expect(shouldCollapseUserMessage({ type: 'user', content })).toBe(true);
  });
});
