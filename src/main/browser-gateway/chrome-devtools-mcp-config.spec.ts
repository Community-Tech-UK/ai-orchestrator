import { describe, expect, it } from 'vitest';
import {
  buildChromeDevtoolsAcpMcpServers,
  buildChromeDevtoolsCodexConfigToml,
  buildChromeDevtoolsGeminiSettingsJson,
  buildChromeDevtoolsMcpConfigJson,
  resolveChromeDevtoolsBridgeSpec,
} from './chrome-devtools-mcp-config';

const BROWSER_URL = 'http://127.0.0.1:31234';
const options = { browserUrl: BROWSER_URL };

describe('chrome-devtools-mcp-config', () => {
  it('builds a bridge that injects --browserUrl after the package spec', () => {
    expect(resolveChromeDevtoolsBridgeSpec(options)).toEqual({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', BROWSER_URL],
    });
  });

  it('returns null when no browserUrl is provided', () => {
    expect(resolveChromeDevtoolsBridgeSpec({ browserUrl: '' })).toBeNull();
    expect(buildChromeDevtoolsMcpConfigJson({ browserUrl: '' })).toBeNull();
    expect(buildChromeDevtoolsCodexConfigToml({ browserUrl: '' })).toBeNull();
    expect(buildChromeDevtoolsGeminiSettingsJson({ browserUrl: '' })).toBeNull();
    expect(buildChromeDevtoolsAcpMcpServers({ browserUrl: '' })).toEqual([]);
  });

  it('builds Claude inline JSON under the chrome-devtools server key', () => {
    const config = JSON.parse(buildChromeDevtoolsMcpConfigJson(options)!);
    expect(config.mcpServers['chrome-devtools']).toEqual({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', BROWSER_URL],
    });
  });

  it('builds Codex TOML with quoted server name and the attach args', () => {
    const toml = buildChromeDevtoolsCodexConfigToml(options)!;
    expect(toml).toContain('[mcp_servers."chrome-devtools"]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:31234"]');
    expect(toml).toContain('tool_timeout_sec = 130');
  });

  it('builds Gemini settings JSON with a millisecond timeout', () => {
    const config = JSON.parse(buildChromeDevtoolsGeminiSettingsJson(options)!);
    const server = config.mcpServers['chrome-devtools'];
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--browserUrl', BROWSER_URL]);
    expect(server.timeout).toBe(130_000);
    expect(server.trust).toBe(false);
  });

  it('builds ACP config with an empty env array', () => {
    const [server] = buildChromeDevtoolsAcpMcpServers(options);
    expect(server.name).toBe('chrome-devtools');
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--browserUrl', BROWSER_URL]);
    expect(server.env).toEqual([]);
  });

  it('honors command/baseArgs/serverName overrides', () => {
    const bridge = resolveChromeDevtoolsBridgeSpec({
      browserUrl: BROWSER_URL,
      command: '/usr/local/bin/chrome-devtools-mcp',
      baseArgs: [],
      serverName: 'chrome-devtools-managed',
    });
    expect(bridge).toEqual({
      command: '/usr/local/bin/chrome-devtools-mcp',
      args: ['--browserUrl', BROWSER_URL],
    });
    const config = JSON.parse(
      buildChromeDevtoolsMcpConfigJson({
        browserUrl: BROWSER_URL,
        serverName: 'chrome-devtools-managed',
      })!,
    );
    expect(config.mcpServers).toHaveProperty('chrome-devtools-managed');
  });
});
