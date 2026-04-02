import { describe, it, expect } from 'vitest';
import { ToolListFilter, type DenyRule, type FilterableTool } from './tool-list-filter';

describe('ToolListFilter', () => {
  const tools: FilterableTool[] = [
    { id: 'bash', description: 'Run commands' },
    { id: 'read', description: 'Read files' },
    { id: 'write', description: 'Write files' },
    { id: 'mcp__server__action', description: 'MCP tool' },
    { id: 'mcp__server__query', description: 'MCP query' },
    { id: 'dangerous_delete', description: 'Delete everything' },
  ];

  it('filters tools by exact name deny rules', () => {
    const rules: DenyRule[] = [{ pattern: 'dangerous_delete', type: 'blanket' }];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    expect(result.map(t => t.id)).not.toContain('dangerous_delete');
    expect(result).toHaveLength(5);
  });

  it('filters tools by prefix pattern (MCP server)', () => {
    const rules: DenyRule[] = [{ pattern: 'mcp__server', type: 'blanket' }];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    expect(result).toHaveLength(4);
  });

  it('filters tools by glob pattern', () => {
    const rules: DenyRule[] = [{ pattern: 'mcp__*', type: 'blanket' }];
    const filter = new ToolListFilter(rules);
    expect(filter.filterForModel(tools)).toHaveLength(4);
  });

  it('returns all tools when no deny rules', () => {
    const filter = new ToolListFilter([]);
    expect(filter.filterForModel(tools)).toHaveLength(6);
  });

  it('supports runtime-deny rules', () => {
    const rules: DenyRule[] = [{ pattern: 'write', type: 'runtime' }];
    const filter = new ToolListFilter(rules);
    expect(filter.filterForModel(tools).map(t => t.id)).toContain('write');
    expect(filter.isRuntimeDenied('write')).toBe(true);
    expect(filter.isRuntimeDenied('read')).toBe(false);
  });
});
