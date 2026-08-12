import { describe, expect, it } from 'vitest';
import {
  buildComputerUseAcpMcpServers,
  buildComputerUseCodexConfigToml,
  buildComputerUseGeminiSettingsJson,
  buildComputerUseMcpConfigJson,
  COMPUTER_USE_MCP_SERVER_NAME,
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
    const server = config.mcpServers[COMPUTER_USE_MCP_SERVER_NAME];

    expect(server.command).toBe(AIO_MCP);
    expect(server.args).toEqual(['computer-use']);
    expect(server.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  // LT-040 regression guard: Claude CLI treats an MCP server literally named
  // "computer-use" as reserved (its own built-in desktop-automation server)
  // and silently classifies it `disabled` — opt-in only via a per-project
  // allowlist — before ever attempting to spawn it, with no error surfaced
  // anywhere in our process. A server registered under that exact name never
  // becomes a live child process of the Claude CLI, so no `computer.*` tool
  // is ever reachable. See docs/plans/livetest-remediation-register.md LT-040.
  it('never registers the MCP server under the literal name "computer-use" (LT-040)', () => {
    const claude = JSON.parse(buildComputerUseMcpConfigJson(options)!);
    const toml = buildComputerUseCodexConfigToml(options)!;
    const gemini = JSON.parse(buildComputerUseGeminiSettingsJson(options)!);
    const [acp] = buildComputerUseAcpMcpServers(options);

    expect(Object.keys(claude.mcpServers)).not.toContain('computer-use');
    expect(toml).not.toContain('[mcp_servers."computer-use"]');
    expect(Object.keys(gemini.mcpServers)).not.toContain('computer-use');
    expect(acp!.name).not.toBe('computer-use');
  });

  it('builds Codex TOML config pointing at the aio-mcp SEA', () => {
    const config = buildComputerUseCodexConfigToml(options);

    expect(config).toContain(`[mcp_servers."${COMPUTER_USE_MCP_SERVER_NAME}"]`);
    expect(config).toContain(`command = "${AIO_MCP}"`);
    expect(config).toContain('args = ["computer-use"]');
    expect(config).toContain(`AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET = "${SOCKET}"`);
  });

  it('builds Gemini and ACP configs with the same bridge env', () => {
    const gemini = JSON.parse(buildComputerUseGeminiSettingsJson(options)!);
    const [acp] = buildComputerUseAcpMcpServers(options);

    expect(gemini.mcpServers[COMPUTER_USE_MCP_SERVER_NAME]).toMatchObject({
      command: AIO_MCP,
      args: ['computer-use'],
    });
    expect(acp).toMatchObject({
      name: COMPUTER_USE_MCP_SERVER_NAME,
      command: AIO_MCP,
      args: ['computer-use'],
    });
  });
});
