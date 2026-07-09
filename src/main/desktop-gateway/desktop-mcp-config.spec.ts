import { describe, expect, it } from 'vitest';
import {
  buildComputerUseAcpMcpServers,
  buildComputerUseCodexConfigToml,
  buildComputerUseGeminiSettingsJson,
  buildComputerUseMcpConfigJson,
  resolveComputerUseBridgeSpec,
} from './desktop-mcp-config';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const SOCKET = '/tmp/computer-use.sock';
const options = {
  aioMcpCliPath: AIO_MCP,
  socketPath: SOCKET,
  instanceId: 'instance-1',
  provider: 'codex',
  exists: () => true,
};

describe('desktop-mcp-config', () => {
  it('builds a bridge pointing at the aio-mcp SEA computer-use subcommand', () => {
    expect(resolveComputerUseBridgeSpec(options)).toEqual({
      command: AIO_MCP,
      args: ['computer-use'],
      env: {
        AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET: SOCKET,
        AI_ORCHESTRATOR_DESKTOP_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_DESKTOP_PROVIDER: 'codex',
      },
    });
  });

  it('returns null when aio-mcp is missing', () => {
    expect(resolveComputerUseBridgeSpec({ ...options, exists: () => false })).toBeNull();
  });

  it('builds Claude inline JSON without ELECTRON_RUN_AS_NODE', () => {
    const config = JSON.parse(buildComputerUseMcpConfigJson(options)!);
    const server = config.mcpServers['computer-use'];

    expect(server.command).toBe(AIO_MCP);
    expect(server.args).toEqual(['computer-use']);
    expect(server.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('builds Codex TOML config pointing at the aio-mcp SEA', () => {
    const config = buildComputerUseCodexConfigToml(options);

    expect(config).toContain('[mcp_servers."computer-use"]');
    expect(config).toContain(`command = "${AIO_MCP}"`);
    expect(config).toContain('args = ["computer-use"]');
    expect(config).toContain(`AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET = "${SOCKET}"`);
  });

  it('builds Gemini and ACP configs with the same bridge env', () => {
    const gemini = JSON.parse(buildComputerUseGeminiSettingsJson(options)!);
    const [acp] = buildComputerUseAcpMcpServers(options);

    expect(gemini.mcpServers['computer-use']).toMatchObject({
      command: AIO_MCP,
      args: ['computer-use'],
    });
    expect(acp).toMatchObject({
      name: 'computer-use',
      command: AIO_MCP,
      args: ['computer-use'],
    });
  });
});
