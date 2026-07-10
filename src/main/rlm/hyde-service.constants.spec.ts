import { describe, expect, it } from 'vitest';
import { HYDE_PROMPTS } from './hyde-service.constants';

describe('HyDE small-model prompt contracts', () => {
  it('bounds every hypothetical document and provides a concrete example', () => {
    for (const prompt of Object.values(HYDE_PROMPTS)) {
      expect(prompt).toContain('at most 10 lines');
      expect(prompt).toContain('Example:');
    }
  });
});
