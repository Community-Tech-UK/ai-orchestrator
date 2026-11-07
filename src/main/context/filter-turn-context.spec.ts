import { describe, expect, it } from 'vitest';
import { filterTurnContext } from './filter-turn-context';
import { TurnInjectionPolicy } from './turn-injection-policy';
import type { ContextAssemblyResult } from './context-engine';
const budget = { totalTokens: 300, rlmMaxTokens: 200, unifiedMaxTokens: 100, rlmTopK: 3 };
const base: ContextAssemblyResult = { budget, rlmContext: null, unifiedMemoryContext: null, indexedCodebaseContext: null };
describe('context item filtering', () => {
  it('drops a repeated section and memory item while retaining new items and headings', () => {
    const policy = new TurnInjectionPolicy(); policy.begin('session', 0, 'Review migration rollback ordering errors');
    const rlm = { context: '[Match 1] first\nold\n\n---\n\n[Match 2] second\nnew', tokens: 20, sectionsAccessed: ['one', 'two'], source: 'hybrid' as const, durationMs: 1 };
    policy.take(['rlm:one'], 10);
    policy.take(['memory:Long-term Memory::- old'], 10);
    const result = filterTurnContext(policy, { ...base, rlmContext: rlm,
      unifiedMemoryContext: { context: 'Long-term Memory:\n- old\n- new', tokens: 20, longTermCount: 2, proceduralCount: 0, durationMs: 1 } });
    expect(result.rlmContext?.sectionsAccessed).toEqual(['two']); expect(result.rlmContext?.context).not.toContain('first');
    expect(result.unifiedMemoryContext?.context).toBe('Long-term Memory:\n- new'); expect(result.unifiedMemoryContext?.longTermCount).toBe(1);
  });
  it('deduplicates code by full file and starting line and enforces the remaining cap on rendered text', () => {
    const policy = new TurnInjectionPolicy(); policy.begin('session', 0, 'Review migration rollback ordering errors');
    const item = { sectionId: 'one', filePath: '/repo/a.ts', relativePath: 'a.ts', content: 'const result = 1;', startLine: 1, endLine: 1, score: 1, matchType: 'bm25' as const };
    const context = { context: '- a.ts:1 (bm25, score 1.000)\n```\nconst result = 1;\n```', tokens: 20, results: [item], storeId: 'store', workspacePath: '/repo', durationMs: 1 };
    expect(filterTurnContext(policy, { ...base, indexedCodebaseContext: context }).indexedCodebaseContext?.results).toHaveLength(1);
    expect(filterTurnContext(policy, { ...base, indexedCodebaseContext: context }).indexedCodebaseContext).toBeNull();
    policy.take(['fill'], policy.remaining - 1);
    expect(filterTurnContext(policy, { ...base, indexedCodebaseContext: { ...context, results: [{ ...item, startLine: 2 }] } }).indexedCodebaseContext).toBeNull();
  });
  it('retains the retrieval service budget trimming instead of expanding raw chunks', () => {
    const policy = new TurnInjectionPolicy(); policy.begin('session', 0, 'Review migration rollback ordering errors');
    const content = '- a.ts:1 (bm25, score 1.000)\n```\nshortened excerpt\n... [truncated]';
    const result = filterTurnContext(policy, { ...base, indexedCodebaseContext: { context: content, tokens: 25,
      results: [{ sectionId: 'one', filePath: '/repo/a.ts', relativePath: 'a.ts', content: 'raw oversized chunk '.repeat(500), startLine: 1, endLine: 1, score: 1, matchType: 'bm25' }],
      storeId: 'store', workspacePath: '/repo', durationMs: 1 } });
    expect(result.indexedCodebaseContext?.context).toBe(content);
  });

});
