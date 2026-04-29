import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetNlWorkflowClassifierForTesting,
  getNlWorkflowClassifier,
} from '../nl-workflow-classifier';

describe('NlWorkflowClassifier', () => {
  beforeEach(() => {
    _resetNlWorkflowClassifierForTesting();
  });

  it('classifies a single-file question as small', () => {
    const result = getNlWorkflowClassifier().classify('explain what main.ts does', {});

    expect(result.size).toBe('small');
    expect(result.surface).toBe('slash-command');
  });

  it('classifies multi-file changes as medium', () => {
    const result = getNlWorkflowClassifier().classify(
      'update auth.ts and refresh.ts to use the new token format',
      {},
    );

    expect(result.size).toBe('medium');
    expect(result.surface).toBe('template-confirm');
  });

  it('classifies review across multiple files as large', () => {
    const result = getNlWorkflowClassifier().classify(
      'review the codebase for security issues in auth.ts, db.ts, api.ts',
      {},
    );

    expect(result.size).toBe('large');
    expect(result.surface).toBe('preflight-modal');
  });

  it('classifies requests for three reviewers as large', () => {
    const result = getNlWorkflowClassifier().classify(
      'spawn 3 reviewers to look at this PR',
      {},
    );

    expect(result.size).toBe('large');
  });
});
