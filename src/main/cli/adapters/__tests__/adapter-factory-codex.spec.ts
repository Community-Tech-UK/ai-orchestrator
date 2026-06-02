import { describe, expect, it } from 'vitest';
import { createCodexAdapter, createCliAdapter } from '../adapter-factory';

describe('adapter factory - codex', () => {
  it('maps yolo Codex instances to danger-full-access sandbox', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      yoloMode: true,
    });

    expect((adapter as unknown as {
      cliConfig: { approvalMode?: string; sandboxMode?: string };
    }).cliConfig).toMatchObject({
      approvalMode: 'full-auto',
      sandboxMode: 'danger-full-access',
    });
  });

  it('keeps non-yolo Codex instances read-only', () => {
    const adapter = createCliAdapter('codex', {
      workingDirectory: '/tmp',
      yoloMode: false,
    });

    expect((adapter as unknown as {
      cliConfig: { approvalMode?: string; sandboxMode?: string };
    }).cliConfig).toMatchObject({
      approvalMode: 'suggest',
      sandboxMode: 'read-only',
    });
  });

  it('does not forward Claude-only reasoning modes to Codex', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      reasoningEffort: 'workflow',
    });

    expect((adapter as unknown as {
      cliConfig: { reasoningEffort?: string };
    }).cliConfig.reasoningEffort).toBeUndefined();
  });

  it('includes the chrome-devtools attach server block in the Codex TOML', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });

    const toml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml ?? '';

    expect(toml).toContain('[mcp_servers."chrome-devtools"]');
    expect(toml).toContain('--browserUrl');
    expect(toml).toContain('http://127.0.0.1:31234');
  });

  it('concatenates browser-gateway and chrome-devtools TOML blocks when both are set', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: {
        aioMcpCliPath: '/tmp/aio-mcp',
        socketPath: '/tmp/browser-gateway.sock',
        instanceId: 'instance-browser',
        exists: () => true,
      },
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });

    const toml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml ?? '';

    expect(toml).toContain('[mcp_servers."browser-gateway"]');
    expect(toml).toContain('[mcp_servers."chrome-devtools"]');
  });
});
