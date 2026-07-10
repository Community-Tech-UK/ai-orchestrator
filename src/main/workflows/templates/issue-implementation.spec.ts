import { describe, expect, it } from 'vitest';

import { issueImplementationTemplate } from './issue-implementation';

describe('issue implementation workflow prompts', () => {
  it('does not ask the model to mutate workflow phase state', () => {
    const triage = issueImplementationTemplate.phases.find((phase) => phase.id === 'triage');

    expect(triage?.systemPromptAddition).toContain('workflow advances automatically');
    expect(triage?.systemPromptAddition).not.toContain('advance to Targeted Investigation');
  });
});
