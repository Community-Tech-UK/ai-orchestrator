import { describe, expect, it } from 'vitest';
import { contrastFailures } from './check-appearance-contrast.mjs';

describe('appearance contrast', () => {
  it('meets WCAG AA for text and UI token pairs', () => {
    expect(contrastFailures()).toEqual([]);
  });
});
