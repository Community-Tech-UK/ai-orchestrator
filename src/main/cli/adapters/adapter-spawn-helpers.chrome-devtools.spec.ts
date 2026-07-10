import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeMcpConfig,
  withBrowserGatewaySystemPrompt,
} from './adapter-spawn-helpers';
import type { UnifiedSpawnOptions } from './adapter-factory.types';

/**
 * Integration-level guard: the array `buildClaudeMcpConfig` returns IS what the
 * Claude adapter passes to `--mcp-config`. On Windows the chrome-devtools server
 * must spawn via `cmd /c npx …` (bare `npx`/`.cmd` fail shell-less), or the MCP
 * server silently never registers its tools — the exact failure seen live.
 */
function chromeDevtoolsServer(): { command: string; args: string[] } {
  const configs = buildClaudeMcpConfig({
    chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:9222' },
  } as UnifiedSpawnOptions);
  expect(configs).toBeDefined();
  const entry = configs!
    .map((c) => JSON.parse(c) as { mcpServers?: Record<string, { command: string; args: string[] }> })
    .find((p) => p.mcpServers?.['chrome-devtools']);
  expect(entry).toBeDefined();
  return entry!.mcpServers!['chrome-devtools'];
}

describe('buildClaudeMcpConfig — chrome-devtools --mcp-config spawn safety', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('emits `cmd /c npx …` on win32 so the MCP server actually launches', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const server = chromeDevtoolsServer();
    expect(server.command).toBe('cmd');
    expect(server.args[0]).toBe('/c');
    expect(server.args).toContain('npx');
    expect(server.args).toContain('http://127.0.0.1:9222');
  });

  it('emits bare `npx` off-Windows (unchanged)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const server = chromeDevtoolsServer();
    expect(server.command).toBe('npx');
    expect(server.args[0]).toBe('-y');
  });

  it('dedupes inline MCP configs by mcpServers key, not incidental string content', () => {
    const existingConfig = JSON.stringify({
      mcpServers: {
        other: {
          command: 'node',
          args: ['browser-gateway'],
        },
      },
    });
    const configs = buildClaudeMcpConfig({
      mcpConfig: [existingConfig],
      browserGatewayMcp: {
        aioMcpCliPath: '/tmp/aio-mcp',
        socketPath: '/tmp/browser.sock',
        instanceId: 'inst-1',
        exists: () => true,
      },
    } as UnifiedSpawnOptions);

    expect(configs).toHaveLength(2);
    expect(configs?.[0]).toBe(existingConfig);
    expect(JSON.parse(configs![1]!).mcpServers).toHaveProperty('browser-gateway');
  });
});

describe('withBrowserGatewaySystemPrompt', () => {
  it('adds the mobile-mcp section even when the prompt already contains browser-gateway guidance', () => {
    const result = withBrowserGatewaySystemPrompt({
      systemPrompt: 'Existing guidance mentions browser.find_or_open already.',
      mobileMcp: {
        serial: 'emulator-5554',
        sdkPath: '/android/sdk',
      },
    } as UnifiedSpawnOptions);

    expect(result.systemPrompt).toContain('browser.find_or_open');
    expect(result.systemPrompt).toContain('[mobile-mcp attached to a leased Android device]');
  });

  it('steers Computer Use input through accessibility targets and escalation', () => {
    const result = withBrowserGatewaySystemPrompt({
      mcpConfig: [JSON.stringify({
        mcpServers: {
          'computer-use': { command: '/tmp/aio-mcp', args: ['computer-use'] },
        },
      })],
    } as UnifiedSpawnOptions);

    expect(result.systemPrompt).toContain('[Harness Computer Use]');
    expect(result.systemPrompt).toContain('computer.accessibility_snapshot');
    expect(result.systemPrompt).toContain('coordinates inside observed app bounds');
    expect(result.systemPrompt).toContain('computer.raise_escalation');
  });
});
