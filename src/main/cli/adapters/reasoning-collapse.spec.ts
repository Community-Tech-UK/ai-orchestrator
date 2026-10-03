import { describe, expect, it } from 'vitest';
import { hasCollapsedReasoning, isCollapsedReasoning } from './reasoning-collapse';

function repeated(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join('\n\n');
}

describe('isCollapsedReasoning', () => {
  it('detects a Hmm. tail, including a token cut off mid-phrase', () => {
    const tail = `${repeated('Hmm.', 40)}\n\nHmm`;
    expect(isCollapsedReasoning(`Real finding about the schema.\n\n${tail}`)).toBe(true);
  });

  it('ignores ordinary reasoning that mentions Hmm once', () => {
    expect(isCollapsedReasoning('The schema omits workspaceCwd.\n\nHmm.\n\nI should read the file.')).toBe(false);
    expect(isCollapsedReasoning('')).toBe(false);
  });

  it('ignores a long line repeated at the tail', () => {
    const line = 'Let me re-read the plan-queue start schema before I decide.';
    expect(isCollapsedReasoning(repeated(line, 40))).toBe(false);
  });

  it('retains a collapsed stretch when a tool result was appended after it', () => {
    const text = `${repeated('Hmm.', 40)}\n\nThe workspace override is not in PlanQueueStartArgsSchema.`;
    expect(isCollapsedReasoning(text)).toBe(true);
  });
});

describe('hasCollapsedReasoning', () => {
  it('matches a collapsed block among earlier real thoughts', () => {
    expect(hasCollapsedReasoning([
      { content: 'Let me check the start schema.' },
      { content: repeated('Hmm.', 30) },
    ])).toBe(true);
  });

  it('matches when each repeated line arrived as its own block', () => {
    const blocks = Array.from({ length: 30 }, () => ({ content: 'Hmm.' }));
    expect(hasCollapsedReasoning(blocks)).toBe(true);
  });

  it('is false for a normal thought', () => {
    expect(hasCollapsedReasoning([{ content: 'The user wants the word.' }])).toBe(false);
    expect(hasCollapsedReasoning(undefined)).toBe(false);
  });
});
