import { describe, expect, it } from 'vitest';
import { renderUserMessage } from './user-message';

describe('renderUserMessage', () => {
  it('joins the explanation and next action without exposing diagnostic detail', () => {
    expect(renderUserMessage({ text: 'Nothing was sent.', next: 'Send again.', detail: 'Raw diagnostic' }))
      .toBe('Nothing was sent. Send again.');
    expect(renderUserMessage({ text: 'Nothing was sent.' })).toBe('Nothing was sent.');
  });
});
