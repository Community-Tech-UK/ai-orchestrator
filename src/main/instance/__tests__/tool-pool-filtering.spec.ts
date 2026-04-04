import { describe, it, expect } from 'vitest';
import { ToolListFilter } from '../../tools/tool-list-filter.js';
import type { DenyRule } from '../../tools/tool-list-filter.js';

describe('ToolListFilter integration with agent permissions', () => {
  it('should filter tools based on deny rules from agent permissions', () => {
    const denyRules: DenyRule[] = [
      { pattern: 'Write', type: 'blanket' },
      { pattern: 'Edit', type: 'blanket' },
      { pattern: 'NotebookEdit', type: 'blanket' },
    ];
    const filter = new ToolListFilter(denyRules);

    const allTools = [
      { id: 'Read', description: 'Read files' },
      { id: 'Write', description: 'Write files' },
      { id: 'Edit', description: 'Edit files' },
      { id: 'Glob', description: 'Find files' },
      { id: 'NotebookEdit', description: 'Edit notebooks' },
      { id: 'Bash', description: 'Run commands' },
    ];

    const filtered = filter.filterForModel(allTools);
    expect(filtered.map(t => t.id)).toEqual(['Read', 'Glob', 'Bash']);
  });

  it('should handle MCP tool namespace patterns', () => {
    const denyRules: DenyRule[] = [
      { pattern: 'mcp__dangerous', type: 'blanket' },
    ];
    const filter = new ToolListFilter(denyRules);

    const tools = [
      { id: 'mcp__dangerous__tool1', description: 'Dangerous tool' },
      { id: 'mcp__safe__tool1', description: 'Safe tool' },
    ];

    const filtered = filter.filterForModel(tools);
    expect(filtered.map(t => t.id)).toEqual(['mcp__safe__tool1']);
  });
});
