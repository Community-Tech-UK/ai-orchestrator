import { describe, it, expect } from 'vitest';
import { createOutputMessage, isCliStderrFailureText, redactArgvForLog } from './base-cli-adapter-utils';

describe('createOutputMessage', () => {
  it('fills id and timestamp when omitted', () => {
    const message = createOutputMessage('error', 'boom');
    expect(message.type).toBe('error');
    expect(message.content).toBe('boom');
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.timestamp).toBeGreaterThan(0);
  });

  it('preserves an explicit id and optional metadata', () => {
    const message = createOutputMessage('assistant', 'hello', {
      id: 'msg-1',
      timestamp: 123,
      metadata: { streaming: true },
    });
    expect(message).toMatchObject({
      id: 'msg-1',
      timestamp: 123,
      type: 'assistant',
      content: 'hello',
      metadata: { streaming: true },
    });
  });
});

describe('redactArgvForLog', () => {
  it('redacts the value after a named flag', () => {
    expect(redactArgvForLog(['--model', 'gpt', '--prompt', 'secret text'], { flag: '--prompt' })).toEqual([
      '--model',
      'gpt',
      '--prompt',
      '<redacted 11 chars>',
    ]);
  });

  it('redacts the last positional argument', () => {
    expect(redactArgvForLog(['--print', 'do the thing'], { lastPositional: true })).toEqual([
      '--print',
      '<redacted 12 chars>',
    ]);
  });

  it('leaves argv unchanged when the flag is absent', () => {
    expect(redactArgvForLog(['--model', 'gpt'], { flag: '--prompt' })).toEqual(['--model', 'gpt']);
  });
});

describe('isCliStderrFailureText', () => {
  it('classifies real failures and ignores banners', () => {
    expect(isCliStderrFailureText('Error: ENOENT')).toBe(true);
    expect(isCliStderrFailureText('gemini-cli version 0.1')).toBe(false);
  });
});
