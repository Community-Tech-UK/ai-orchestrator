import { describe, expect, it } from 'vitest';
import {
  MOBILE_MCP_VERSION,
  buildMobileMcpAcpMcpServers,
  buildMobileMcpCodexConfigToml,
  buildMobileMcpGeminiSettingsJson,
  buildMobileMcpConfigJson,
} from './mobile-mcp-config';

describe('mobile-mcp config builders', () => {
  const options = {
    serial: 'emulator-5554',
    sdkPath: '/android/sdk',
  };

  it('builds Claude/Copilot JSON with telemetry disabled and a pinned mobile-mcp version', () => {
    const json = JSON.parse(buildMobileMcpConfigJson(options)!);
    expect(json.mcpServers['mobile-mcp']).toEqual({
      command: 'npx',
      args: ['-y', `@mobilenext/mobile-mcp@${MOBILE_MCP_VERSION}`],
      env: {
        MOBILEMCP_DISABLE_TELEMETRY: '1',
        ANDROID_HOME: '/android/sdk',
        ANDROID_SDK_ROOT: '/android/sdk',
        ANDROID_SERIAL: 'emulator-5554',
      },
    });
  });

  it('builds Codex TOML including environment variables', () => {
    const toml = buildMobileMcpCodexConfigToml(options)!;
    expect(toml).toContain('[mcp_servers."mobile-mcp"]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain(`"@mobilenext/mobile-mcp@${MOBILE_MCP_VERSION}"`);
    expect(toml).toContain('ANDROID_SERIAL = "emulator-5554"');
    expect(toml).toContain('MOBILEMCP_DISABLE_TELEMETRY = "1"');
  });

  it('builds Gemini settings and ACP server arrays', () => {
    const gemini = JSON.parse(buildMobileMcpGeminiSettingsJson(options)!);
    expect(gemini.mcpServers['mobile-mcp'].env.ANDROID_SERIAL).toBe('emulator-5554');

    const [server] = buildMobileMcpAcpMcpServers(options);
    expect(server.name).toBe('mobile-mcp');
    expect(server.env).toContainEqual({ name: 'ANDROID_SERIAL', value: 'emulator-5554' });
  });

  it('adds an optional Maestro MCP server when requested', () => {
    const json = JSON.parse(buildMobileMcpConfigJson({ ...options, maestro: true })!);
    expect(json.mcpServers.maestro).toEqual({
      command: 'maestro',
      args: ['mcp'],
      env: {
        ANDROID_HOME: '/android/sdk',
        ANDROID_SDK_ROOT: '/android/sdk',
        ANDROID_SERIAL: 'emulator-5554',
      },
    });

    const toml = buildMobileMcpCodexConfigToml({ ...options, maestro: true })!;
    expect(toml).toContain('[mcp_servers.maestro]');
    expect(toml).toContain('command = "maestro"');
    expect(toml).toContain('args = ["mcp"]');

    const servers = buildMobileMcpAcpMcpServers({ ...options, maestro: true });
    expect(servers.map((server) => server.name)).toEqual(['mobile-mcp', 'maestro']);
  });

  it('keeps the mobile and Maestro servers distinct when serverName is maestro', () => {
    const collisionOptions = { ...options, serverName: 'maestro', maestro: true };
    const json = JSON.parse(buildMobileMcpConfigJson(collisionOptions)!);

    expect(Object.keys(json.mcpServers).sort()).toEqual(['maestro', 'mobile-mcp']);
    expect(json.mcpServers['mobile-mcp'].command).toBe('npx');
    expect(json.mcpServers.maestro.command).toBe('maestro');

    const toml = buildMobileMcpCodexConfigToml(collisionOptions)!;
    expect(toml.match(/\[mcp_servers\.maestro\]/g)).toHaveLength(1);
    expect(toml).toContain('[mcp_servers."mobile-mcp"]');

    const servers = buildMobileMcpAcpMcpServers(collisionOptions);
    expect(servers.map((server) => server.name).sort()).toEqual(['maestro', 'mobile-mcp']);
  });

  it('returns null/empty when no serial is supplied', () => {
    expect(buildMobileMcpConfigJson({ serial: '', sdkPath: '/android/sdk' })).toBeNull();
    expect(buildMobileMcpCodexConfigToml({ serial: '', sdkPath: '/android/sdk' })).toBeNull();
    expect(buildMobileMcpGeminiSettingsJson({ serial: '', sdkPath: '/android/sdk' })).toBeNull();
    expect(buildMobileMcpAcpMcpServers({ serial: '', sdkPath: '/android/sdk' })).toEqual([]);
  });
});
