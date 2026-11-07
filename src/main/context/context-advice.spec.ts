import { describe, expect, it } from 'vitest';
import { buildContextAdvice } from './context-advice';
describe('context advice', () => {
  it('suggests compacting only for large tool output and approaching the real summary point', () => {
    const advice = buildContextAdvice({ totalTokens: 120000, maxTokens: 200000, autoCompactThreshold: 140000,
      toolResultTokens: 30000, topTools: [{ name: 'Bash', tokens: 30000 }], categories: [{ name: 'System prompt', tokens: 5000 }] }, {});
    expect(advice.filter(a => a.action === 'compact-now')).toHaveLength(2);
    expect(advice.find(a => a.id === 'tool-output')?.text).toContain('Bash');
    const setup = advice.find(a => a.id === 'setup');
    expect(setup?.text).not.toMatch(/remove|trim|disable/i);
    expect(setup?.action).toBeUndefined();
    expect(buildContextAdvice({ totalTokens: 100000, toolResultTokens: 9999, categories: [] }, {})).toEqual([]);
  });
  it('suppresses advice for machine sessions with the canonical session rule', () => {
    expect(buildContextAdvice({ totalTokens: 120000, toolResultTokens: 40000, categories: [] }, { instance: { metadata: { planQueueRole: 'worker' } } })).toEqual([]);
  });
});
