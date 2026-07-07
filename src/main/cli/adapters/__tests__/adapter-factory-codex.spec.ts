import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter, createCliAdapter } from '../adapter-factory';

const codexTmpDirs: string[] = [];
function writeStaticMcpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-codex-static-mcp-'));
  const path = join(dir, 'mcp-servers.json');
  writeFileSync(path, contents, 'utf8');
  codexTmpDirs.push(dir);
  return path;
}

afterEach(() => {
  for (const dir of codexTmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    const config = (adapter as unknown as {
      cliConfig: { browserGatewayInstanceId?: string };
    }).cliConfig;

    expect(toml).toContain('[mcp_servers."browser-gateway"]');
    expect(toml).toContain('[mcp_servers."chrome-devtools"]');
    expect(config.browserGatewayInstanceId).toBe('instance-browser');
  });

  it('converts the inline orchestrator-tools bridge into Codex TOML', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      mcpConfig: [
        JSON.stringify({
          mcpServers: {
            orchestrator: {
              command: '/tmp/aio-mcp',
              args: ['orchestrator-tools'],
              env: {
                AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: '/tmp/orchestrator-tools.sock',
                AI_ORCHESTRATOR_INSTANCE_ID: 'instance-tools',
              },
            },
          },
        }),
      ],
    });

    const toml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml ?? '';

    expect(toml).toContain('[mcp_servers.orchestrator]');
    expect(toml).toContain('command = "/tmp/aio-mcp"');
    expect(toml).toContain('args = ["orchestrator-tools"]');
    expect(toml).toContain('[mcp_servers.orchestrator.env]');
    expect(toml).toContain('AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET = "/tmp/orchestrator-tools.sock"');
    expect(toml).toContain('AI_ORCHESTRATOR_INSTANCE_ID = "instance-tools"');
  });

  it('does not duplicate browser-gateway when an inline bridge and dedicated Codex config are both present', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      instanceId: 'instance-browser',
      browserGatewayMcp: {
        aioMcpCliPath: '/tmp/aio-mcp',
        socketPath: '/tmp/browser-gateway.sock',
        instanceId: 'instance-browser',
        exists: () => true,
      },
      mcpConfig: [
        JSON.stringify({
          mcpServers: {
            'browser-gateway': { command: '/tmp/aio-mcp', args: ['browser-gateway'] },
          },
        }),
      ],
    });

    const toml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml ?? '';

    expect(toml.match(/\[mcp_servers\."browser-gateway"\]/g)?.length).toBe(1);
  });

  it('injects static config/mcp-servers.json servers (e.g. imap) into the Codex TOML', () => {
    const staticConfig = writeStaticMcpConfig(
      JSON.stringify({
        mcpServers: {
          imap: { command: 'node', args: ['/x/imap-mcp-server/dist/index.js'] },
        },
      }),
    );

    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      mcpConfig: [staticConfig],
    });

    const toml = (adapter as unknown as {
      cliConfig: { mcpServersConfigToml?: string };
    }).cliConfig.mcpServersConfigToml ?? '';

    expect(toml).toContain('[mcp_servers.imap]');
    expect(toml).toContain('args = ["/x/imap-mcp-server/dist/index.js"]');
  });
});
