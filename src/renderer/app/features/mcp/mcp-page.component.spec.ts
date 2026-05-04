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
});
