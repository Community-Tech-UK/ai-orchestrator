import { describe, expect, it } from 'vitest';

import {
  REVIEW_SEVERITY_PROMPT,
  REVIEW_SEVERITY_VALUES,
  ReviewSeveritySchema,
} from './review-severity';

describe('review severity contract', () => {
  it('exposes one closed four-level scale', () => {
    expect(REVIEW_SEVERITY_VALUES).toEqual(['critical', 'high', 'medium', 'low']);
    expect(ReviewSeveritySchema.safeParse('critical').success).toBe(true);
    expect(ReviewSeveritySchema.safeParse('info').success).toBe(false);
    expect(ReviewSeveritySchema.safeParse('major').success).toBe(false);
  });

  it('documents each level and the shared confidence convention', () => {
    for (const severity of REVIEW_SEVERITY_VALUES) {
      expect(REVIEW_SEVERITY_PROMPT).toContain(`**${severity}**`);
    }
    expect(REVIEW_SEVERITY_PROMPT).toContain('0-100');
  });
});
