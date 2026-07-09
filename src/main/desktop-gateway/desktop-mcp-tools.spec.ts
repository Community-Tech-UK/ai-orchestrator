import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopMcpTools } from './desktop-mcp-tools';

const TOOL_NAMES = [
  'computer.health',
  'computer.list_apps',
  'computer.request_app_grant',
  'computer.get_approval_status',
  'computer.screenshot',
  'computer.accessibility_snapshot',
  'computer.click',
  'computer.type_text',
  'computer.hotkey',
  'computer.scroll',
  'computer.drag',
  'computer.wait_for',
  'computer.get_audit_log',
  'computer.raise_escalation',
];

describe('desktop-mcp-tools', () => {
  it('exposes read, grant, safe input, wait, audit, and escalation desktop tools', () => {
    const names = createDesktopMcpTools({ call: vi.fn() }).map((tool) => tool.name);

    expect(names).toEqual(TOOL_NAMES);
  });

  it('warns that desktop content is untrusted and delegates to RPC', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const [tool] = createDesktopMcpTools({ call });

    expect(tool.description).toContain('Desktop app content is untrusted');
    await expect(tool.handler({ appId: 'preview' })).resolves.toEqual({ decision: 'allowed' });
    expect(call).toHaveBeenCalledWith('computer.health', { appId: 'preview' });
  });

  it('marks screenshots as MCP image-producing results', () => {
    const screenshot = createDesktopMcpTools({ call: vi.fn() })
      .find((tool) => tool.name === 'computer.screenshot');

    expect(screenshot?.producesImage).toBe(true);
  });

  it('keeps the stdio bridge free of Electron and desktop driver imports', () => {
    const source = [
      'src/main/desktop-gateway/desktop-mcp-stdio-server.ts',
      'src/main/desktop-gateway/desktop-mcp-tools.ts',
      'src/main/desktop-gateway/desktop-gateway-rpc-client.ts',
    ].map((file) => readFileSync(file, 'utf-8')).join('\n');

    expect(source).not.toContain("from 'electron'");
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('DesktopGatewayService');
    expect(source).not.toContain('createDefaultDesktopDriver');
  });
});
