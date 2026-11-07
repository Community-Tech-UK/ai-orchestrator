import { describe, expect, it } from 'vitest';
import { mapClaudeContextUsage } from './claude-context-usage';
describe('Claude measured context', () => {
  it('maps provider categories, safe basenames and grouped connector tools and bounds the tool list', () => {
    const measured = mapClaudeContextUsage({ categories: [{ name: 'Messages', tokens: 40000, isDeferred: false }],
      totalTokens: 40000, maxTokens: 200000, percentage: 20, autoCompactThreshold: 160000,
      memoryFiles: [{ path: '/private/project/CLAUDE.md', tokens: 1000 }],
      mcpTools: [{ name: 'mcp__files__read', serverName: 'files', tokens: 500, isDeferred: false },
        { name: 'mcp__files__write', serverName: 'files', tokens: 400, isDeferred: true }],
      messageBreakdown: { toolResultTokens: 15000, toolCallsByType: [{ name: 'Bash', resultTokens: 15000 }] }, unknown: 'ignored' });
    expect(measured).toMatchObject({ totalTokens: 40000, memoryFiles: [{ name: 'CLAUDE.md', tokens: 1000 }],
      connectorTools: [{ server: 'files', loadedTokens: 500, deferredTokens: 400 }], topTools: [{ name: 'Bash', tokens: 15000 }] });
    expect(measured).not.toHaveProperty('unknown');
    expect(mapClaudeContextUsage({ categories: [], totalTokens: 'wrong' })).toBeUndefined();
  });
});
