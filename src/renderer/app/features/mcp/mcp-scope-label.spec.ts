import { describe, expect, it } from 'vitest';
import { mcpScopeLabel } from './mcp-scope-label';
import type { OrchestratorMcpScope } from '../../../../shared/types/mcp-scopes.types';

describe('MCP scope presentation', () => {
  it.each([
    ['orchestrator', 'Harness'],
    ['orchestrator-bootstrap', 'Harness bootstrap'],
    ['orchestrator-codemem', 'Harness memory'],
  ] satisfies [OrchestratorMcpScope, string][])('names %s without changing its stored value', (scope, label) => {
    expect(mcpScopeLabel(scope)).toBe(label);
    expect(scope).toMatch(/^orchestrator/);
  });

  it('preserves provider scopes and project paths in diagnostics', () => {
    expect(mcpScopeLabel('user')).toBe('user');
    expect(mcpScopeLabel('/work/project')).toBe('/work/project');
    expect(mcpScopeLabel(undefined)).toBe('');
  });
});
