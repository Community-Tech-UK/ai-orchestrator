import { describe, expect, it } from 'vitest';
import { prReviewTemplate } from './pr-review';

describe('PR review prompt calibration', () => {
  it('uses one severity and confidence format across every review agent', () => {
    const prompts = prReviewTemplate.phases
      .flatMap((phase) => phase.agents?.prompts ?? []);
    for (const prompt of prompts) {
      expect(prompt).toContain('[critical|high|medium|low] [confidence NN/100] file:line');
      expect(prompt).toContain('If no qualifying findings');
    }
    expect(prompts.join('\n')).not.toContain('Severity (1-10)');
  });

  it('does not ask the agent to advance workflow state itself', () => {
    const context = prReviewTemplate.phases.find((phase) => phase.id === 'context');
    expect(context?.systemPromptAddition).toContain('workflow advances automatically');
    expect(context?.systemPromptAddition).not.toContain('advance to the Security Review');
  });

  it('enforces the repository prompt house style when a PR changes prompts or parsers', () => {
    const qualityPrompts = prReviewTemplate.phases
      .find((phase) => phase.id === 'quality')
      ?.agents?.prompts.join('\n');

    expect(qualityPrompts).toContain('docs/prompt-engineering-house-style.md');
    expect(qualityPrompts).toContain('LLM-facing prompt or parser');
  });
});
