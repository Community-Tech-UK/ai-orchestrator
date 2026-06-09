import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeMcpConfig } from './adapter-spawn-helpers';
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
});
