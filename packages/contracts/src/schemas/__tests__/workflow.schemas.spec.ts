import { describe, expect, it } from 'vitest';

import {
  WorkflowCanTransitionPayloadSchema,
  WorkflowNlSuggestPayloadSchema,
} from '../workflow.schemas';

describe('workflow IPC schemas', () => {
  it('accepts workflow transition preview payloads', () => {
    const result = WorkflowCanTransitionPayloadSchema.safeParse({
      instanceId: 'inst-1',
      templateId: 'wf-review',
      source: 'manual-ui',
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid workflow start sources', () => {
    const result = WorkflowCanTransitionPayloadSchema.safeParse({
      instanceId: 'inst-1',
      templateId: 'wf-review',
      source: 'background',
    });

    expect(result.success).toBe(false);
  });

  it('accepts natural-language suggestion payloads', () => {
    const result = WorkflowNlSuggestPayloadSchema.safeParse({
      promptText: 'review auth.ts and db.ts',
      provider: 'claude',
      workingDirectory: '/repo',
    });

    expect(result.success).toBe(true);
  });
});
