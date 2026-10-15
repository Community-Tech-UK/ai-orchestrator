import { describe, expect, it } from 'vitest';
import { classifyQuestionRisk, countsTowardNeedsYou, attentionLevelForLoopQuestion, loopQuestionNeed } from './question-need';
import type { LoopOutstandingItem } from '../types/loop-outstanding.types';

describe('question risk words', () => {
  it('counts only new unanswered actionable questions and decisions, with waiting risk precedence', () => {
    const item = { kind: 'decision-applied', status: 'open', firstSeenRound: 1, userResponse: null } as LoopOutstandingItem;
    expect(countsTowardNeedsYou(item)).toBe(true);
    expect(attentionLevelForLoopQuestion(item)).toBe('review');
    expect(loopQuestionNeed({ ...item, riskClass: 'money' })).toBe('answer');
    expect(attentionLevelForLoopQuestion({ ...item, riskClass: 'money' })).toBe('blocked');
    expect(countsTowardNeedsYou({ ...item, firstSeenRound: null })).toBe(false);
    expect(countsTowardNeedsYou({ ...item, userResponse: 'yes' })).toBe(false);
    expect(countsTowardNeedsYou({ ...item, kind: 'for-information' })).toBe(false);
  });
  const cases = {
    scope: ['This is out of scope', 'Descope the feature', 'Defer this task', 'Change the acceptance criteria', 'Install a dependency', 'Add a new migration'],
    money: ['Buy the subscription', 'Top up credits', 'Upgrade the Vercel plan to Pro', 'Use a paid API', 'Increase the budget cap', 'Spend £20'],
    deletion: ['Delete old database records', 'Remove that file', 'Purge the backups', 'Run rm -rf on it', 'git reset --hard', 'Rewrite history'],
    shared: ['Publish the release', 'Deploy to staging', 'Update DNS', 'Change global settings in ~/.codex', 'Send an email', 'Use another repository'],
  } as const;
  for (const [risk, texts] of Object.entries(cases)) {
    it.each(texts)('flags %s', (text) => expect(classifyQuestionRisk(text)).toBe(risk));
  }
  it.each([
    'Reuse the existing helper', 'Rearrange the tests', 'Name the variable clearly',
    'Right-align the cost column', 'Use a cheaper algorithm', 'Format the usage count',
    'Delete a helper this run added', 'Remove an unused import', 'Remove this duplicate assertion',
    'Use a label that says Server', 'Edit a local config file inside this workspace', 'Rename this component',
  ])('keeps ordinary implementation choices low risk: %s', (text) => expect(classifyQuestionRisk(text)).toBeNull());
});
