import { describe, expect, it } from 'vitest';
import { RESUME_COMPOSER_COPY } from './tooltip-copy-resume-composer';

describe('RESUME_COMPOSER_COPY wording', () => {
  it('has no capital ON or OFF in any composer or header hover', () => {
    const offenders = Object.entries(RESUME_COMPOSER_COPY)
      .filter(([, entry]) => /\b(?:ON|OFF|FAST)\b/.test(`${entry.label} ${entry.meaning}`))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
