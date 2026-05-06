import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('McpPageComponent template', () => {
  it('labels direct Chrome DevTools MCP as legacy raw browser automation', () => {
    const template = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.html',
      'utf-8',
    );

    expect(template).toContain('Legacy raw browser automation');
    expect(template).toContain('/browser');
  });

  it('renders the six multi-provider management tabs', () => {
    const source = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.ts',
      'utf-8',
    );

    for (const label of ['Orchestrator', 'Shared', 'Claude', 'Codex', 'Gemini', 'Copilot']) {
      expect(source).toContain(`label: '${label}'`);
    }
  });

  it('wires multi-provider CRUD and fan-out actions in the template', () => {
    const template = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.html',
      'utf-8',
    );

    expect(template).toContain('beginCreateManagementServer()');
    expect(template).toContain('submitManagementServer()');
    expect(template).toContain('deleteManagementServer(server)');
    expect(template).toContain('fanOutSharedServer(server)');
    expect(template).toContain('openCurrentProviderUserFile()');
  });

  it('does not submit redacted URL or arg placeholders as real values', () => {
    const source = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.ts',
      'utf-8',
    );

    expect(source).toContain('!args.includes(REDACTED_SENTINEL)');
    expect(source).toContain('!url.includes(REDACTED_SENTINEL)');
    expect(source).toContain('orchestratorInjectionProviders');
  });
});
