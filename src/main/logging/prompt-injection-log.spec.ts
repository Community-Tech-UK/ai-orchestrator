import { beforeEach, describe, expect, it, vi } from 'vitest';

const debug = vi.fn();
vi.mock('./logger', () => ({ getLogger: () => ({ debug }) }));

import { logPromptInjection } from './prompt-injection-log';
import { wrapRtkAwareness } from '../cli/rtk/rtk-awareness';

describe('logPromptInjection', () => {
  beforeEach(() => debug.mockClear());

  it('logs the surface, the character count and the session once per injection', () => {
    logPromptInjection('child', 'abcde', 'session-1');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('Prompt injected', { surface: 'child', characters: 5, session: 'session-1' });
  });

  it('logs nothing for empty text', () => {
    logPromptInjection('child', '', 's');
    logPromptInjection('child', null, 's');
    logPromptInjection('child', undefined, 's');
    expect(debug).not.toHaveBeenCalled();
  });

  it('is called by the RTK note with the length of the text it returns', () => {
    const text = wrapRtkAwareness('session-2');
    expect(debug).toHaveBeenCalledWith('Prompt injected', { surface: 'rtk', characters: text.length, session: 'session-2' });
  });
});
