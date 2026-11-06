import { describe, expect, it } from 'vitest';
import { presentError } from '../../../../shared/present-error';
import { presentUsageFailure } from './usage-insight-failure';

const RAW = "EACCES: permission denied, scandir '/Users/someone/.claude/projects'";
const CARD_HEADLINE = "Harness couldn't work out where your usage went.";
const CARD_ADVICE = 'What to do: Check Details, then try again.';

describe('presentUsageFailure', () => {
  it.each([
    ['an error thrown while asking', new Error(RAW)],
    ['an answer that failed', { message: RAW }],
    ['plain text from the main process', RAW],
  ])('keeps the raw text out of the sentences for %s', (_name, source) => {
    const failure = presentUsageFailure(source);
    expect(failure.rawDetail).toBe(RAW);
    expect(failure.headline).toBe(CARD_HEADLINE);
    expect(failure.whatToDo).toBe(CARD_ADVICE);
    expect(failure.headline + failure.whatToDo).not.toMatch(/EACCES|scandir|\/Users|projects/);
  });

  it("says nothing about a chat message, which this card doesn't have", () => {
    expect(presentUsageFailure(RAW).whatToDo).not.toMatch(/message|work above/i);
    // The shared wording for the same case does mention it, which is why the card words this one itself.
    expect(presentError('unknown', { provider: 'claude' }).whatToDo).toMatch(/message/);
  });

  it('never treats plain text from the main process as a failure code', () => {
    for (const text of ['quota', 'ECONNRESET', 'cancelled']) {
      const failure = presentUsageFailure(text);
      expect(failure).toEqual({ headline: CARD_HEADLINE, whatToDo: CARD_ADVICE, rawDetail: text });
    }
  });

  it('uses the shared wording when the error is a kind the shared presenter recognises', () => {
    const failure = presentUsageFailure({ code: 'ECONNRESET', message: RAW });
    const shared = presentError({ code: 'ECONNRESET' }, { provider: 'claude' });
    expect(failure.headline).toBe(shared.headline);
    expect(failure.whatToDo).toBe(shared.whatToDo);
    expect(failure.rawDetail).toBe(RAW);
    expect(failure.headline + failure.whatToDo).not.toContain('EACCES');
  });

  it('copes with no information at all', () => {
    expect(presentUsageFailure(undefined)).toEqual({ headline: CARD_HEADLINE, whatToDo: CARD_ADVICE, rawDetail: '' });
    expect(presentUsageFailure(null).rawDetail).toBe('');
  });

  it('leaves out anything that is not text', () => {
    const failure = presentUsageFailure({ message: { nested: RAW }, code: 42 });
    expect(failure.rawDetail).toBe('');
    expect(failure.headline).toBe(CARD_HEADLINE);
  });
});
