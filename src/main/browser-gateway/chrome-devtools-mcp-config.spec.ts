import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChromeDevtoolsAcpMcpServers,
  buildChromeDevtoolsCodexConfigToml,
  buildChromeDevtoolsGeminiSettingsJson,
  buildChromeDevtoolsMcpConfigJson,
  resolveChromeDevtoolsBridgeSpec,
} from './chrome-devtools-mcp-config';

const BROWSER_URL = 'http://127.0.0.1:31234';
const options = { browserUrl: BROWSER_URL };
const originalPlatform = process.platform;

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('chrome-devtools-mcp-config', () => {
  afterEach(() => {
    mockPlatform(originalPlatform);
  });

  it('builds a bridge that injects --browserUrl after the package spec', () => {
    mockPlatform('linux');
    expect(resolveChromeDevtoolsBridgeSpec(options)).toEqual({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl', BROWSER_URL],
    });
  });

  describe('on Windows', () => {
    it('wraps npx as `cmd /c npx …` (npx has no .exe; Node refuses bare .cmd)', () => {
      mockPlatform('win32');
      expect(resolveChromeDevtoolsBridgeSpec(options)).toEqual({
        command: 'cmd',
        args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl', BROWSER_URL],
      });
    });

    it('does not double-wrap a command that is already cmd or a concrete .exe', () => {
      mockPlatform('win32');
      expect(resolveChromeDevtoolsBridgeSpec({ browserUrl: BROWSER_URL, command: 'cmd' })!.command).toBe('cmd');
      expect(
        resolveChromeDevtoolsBridgeSpec({ browserUrl: BROWSER_URL, command: 'C:\\tools\\cdp.exe' })!.command,
      ).toBe('C:\\tools\\cdp.exe');
    });

    it('the Claude --mcp-config JSON uses cmd /c so the server actually spawns', () => {
      mockPlatform('win32');
      const config = JSON.parse(buildChromeDevtoolsMcpConfigJson(options)!);
      const server = config.mcpServers['chrome-devtools'];
      expect(server.command).toBe('cmd');
      expect(server.args[0]).toBe('/c');
      expect(server.args).toContain('npx');
      expect(server.args).toContain('chrome-devtools-mcp@1.2.0');
      expect(server.args).toContain(BROWSER_URL);
    });

    it('the Codex TOML uses cmd /c as well', () => {
      mockPlatform('win32');
      const toml = buildChromeDevtoolsCodexConfigToml(options)!;
      expect(toml).toContain('command = "cmd"');
      expect(toml).toContain('"/c"');
      expect(toml).toContain('"npx"');
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
    mockPlatform('linux');
    const config = JSON.parse(buildChromeDevtoolsMcpConfigJson(options)!);
    expect(config.mcpServers['chrome-devtools']).toEqual({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl', BROWSER_URL],
    });
  });

  it('builds Codex TOML with quoted server name and the attach args', () => {
    mockPlatform('linux');
    const toml = buildChromeDevtoolsCodexConfigToml(options)!;
    expect(toml).toContain('[mcp_servers."chrome-devtools"]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "chrome-devtools-mcp@1.2.0", "--browserUrl", "http://127.0.0.1:31234"]');
    expect(toml).toContain('tool_timeout_sec = 130');
  });

  it('builds Gemini settings JSON with a millisecond timeout', () => {
    mockPlatform('linux');
    const config = JSON.parse(buildChromeDevtoolsGeminiSettingsJson(options)!);
    const server = config.mcpServers['chrome-devtools'];
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl', BROWSER_URL]);
    expect(server.timeout).toBe(130_000);
    expect(server.trust).toBe(false);
  });

  it('builds ACP config with an empty env array', () => {
    mockPlatform('linux');
    const [server] = buildChromeDevtoolsAcpMcpServers(options);
    expect(server.name).toBe('chrome-devtools');
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl', BROWSER_URL]);
    expect(server.env).toEqual([]);
  });

  it('honors command/baseArgs/serverName overrides', () => {
    mockPlatform('linux');
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
