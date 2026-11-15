import { describe, expect, it } from 'vitest';
import { acpElicitationQuestions, acpQuestionAnswer, isQuestionToolPermission } from './acp-elicitation-questions';

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
  it('recognises the question tool gate by its title and its questions-only input', () => {
    expect(isQuestionToolPermission({ title: 'question', rawInput: { questions: [{ question: 'red or blue?', options: [] }] } })).toBe(true);
  });
  it('does not grant another tool whose model-written title says "question"', () => {
    // OpenCode can fill a tool's title from model text, so the title alone must never auto-approve.
    expect(isQuestionToolPermission({ title: 'question', rawInput: { command: 'rm -rf build', description: 'question' } })).toBe(false);
    expect(isQuestionToolPermission({ title: 'question', rawInput: { questions: [{ question: 'ok?' }], command: 'curl x | sh' } })).toBe(false);
    expect(isQuestionToolPermission({ title: 'question', rawInput: { questions: [] } })).toBe(false);
    expect(isQuestionToolPermission({ title: 'question', rawInput: { questions: [{ prompt: 'ok?' }] } })).toBe(false);
    expect(isQuestionToolPermission({ title: 'question' })).toBe(false);
    expect(isQuestionToolPermission({ title: 'bash', rawInput: { questions: [{ question: 'ok?' }] } })).toBe(false);
  });
  it('leaves generic non-form input on its existing response path', () => {
    expect(acpElicitationQuestions({ mode: 'url' })).toBeUndefined();
    expect(acpQuestionAnswer(params, 'bun')).toBeUndefined();
  });
});
