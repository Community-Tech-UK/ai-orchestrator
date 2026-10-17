import { describe, expect, it } from 'vitest';
import { acpElicitationQuestions, acpQuestionAnswer } from './acp-elicitation-questions';

const params = { mode: 'form' as const, requestedSchema: { type: 'object', properties: {
  manager: { type: 'string', title: 'Package manager', oneOf: [{ const: 'bun', title: 'Bun' }, { const: 'npm', title: 'NPM' }] },
  targets: { type: 'array', items: { type: 'string', enum: ['web', 'mobile'] } },
  details: { type: 'string', title: 'Extra details' },
} } };

describe('ACP elicitation question UI bridge', () => {
  it('projects form fields as named choices, multiple choices and free text', () => {
    expect(acpElicitationQuestions(params)).toEqual([
      { header: 'manager', question: 'Package manager', multiSelect: false, options: [{ label: 'Bun' }, { label: 'NPM' }] },
      { header: 'targets', question: 'targets', multiSelect: true, options: [{ label: 'web' }, { label: 'mobile' }] },
      { header: 'details', question: 'Extra details', multiSelect: false, options: [] },
    ]);
  });
  it('restores schema values from the question card labels without ending the turn', () => {
    expect(acpQuestionAnswer(params, JSON.stringify({ manager: 'Bun', targets: ['web', 'mobile'], details: 'Leave scripts as-is' })))
      .toEqual({ manager: 'bun', targets: ['web', 'mobile'], details: 'Leave scripts as-is' });
  });
  it('leaves generic non-form input on its existing response path', () => {
    expect(acpElicitationQuestions({ mode: 'url' })).toBeUndefined();
    expect(acpQuestionAnswer(params, 'bun')).toBeUndefined();
  });
});
