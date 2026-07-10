import { describe, expect, it } from 'vitest';
import { featureDevelopmentTemplate } from './feature-development';

describe('feature development workflow prompt portability', () => {
  it('uses provider-neutral task tracking vocabulary', () => {
    const prompts = featureDevelopmentTemplate.phases
      .map((phase) => phase.systemPromptAddition ?? '')
      .join('\n');
    expect(prompts).not.toContain('TodoWrite');
    expect(prompts).toContain('task or todo tooling, if available');
  });

  it('does not demand indiscriminate file reads or duplicate a passed approval gate', () => {
    const exploration = featureDevelopmentTemplate.phases.find((phase) => phase.id === 'exploration');
    const implementation = featureDevelopmentTemplate.phases.find((phase) => phase.id === 'implementation');
    expect(exploration?.systemPromptAddition).not.toContain('Read ALL files');
    expect(exploration?.systemPromptAddition).toContain('deduplicate');
    expect(implementation?.systemPromptAddition).not.toContain('DO NOT START WITHOUT EXPLICIT USER APPROVAL');
  });

  it('gives review agents a common evidence-bearing finding format', () => {
    const review = featureDevelopmentTemplate.phases.find((phase) => phase.id === 'review');
    for (const prompt of review?.agents?.prompts ?? []) {
      expect(prompt).toContain('[severity] [confidence NN/100] file:line');
      expect(prompt).toContain('If no qualifying findings');
    }
  });
});
