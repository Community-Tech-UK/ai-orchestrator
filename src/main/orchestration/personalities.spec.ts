import { describe, expect, it } from 'vitest';
import { PERSONALITY_PROMPTS } from './personalities';

describe('verification personality prompts', () => {
  it('defines functional evidence roles instead of decorative authority personas', () => {
    const combined = Object.values(PERSONALITY_PROMPTS).join('\n');
    expect(combined).not.toContain('Provide authoritative guidance');
    expect(combined).not.toContain('challenge the majority view');

    for (const prompt of Object.values(PERSONALITY_PROMPTS)) {
      expect(prompt.toLowerCase()).toContain('evidence');
      expect(prompt.toLowerCase()).toMatch(/if .*no .*issue|if .*holds|do not invent|do not manufacture/);
    }
  });

  it('gives the challenge role a stop condition when the original position holds', () => {
    const prompt = PERSONALITY_PROMPTS['devils-advocate'];
    expect(prompt).toContain('strongest claim');
    expect(prompt).toContain('If it holds');
  });

  it('requires the domain role to distinguish sourced knowledge from uncertainty', () => {
    const prompt = PERSONALITY_PROMPTS['domain-expert'];
    expect(prompt).toContain('source-backed');
    expect(prompt).toContain('uncertain');
  });
});
