import { readFileSync, rmSync } from 'fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter, mapSettingsToDetectionType } from '../adapter-factory';
import { GeminiCliAdapter } from '../gemini-cli-adapter';
import type { CliMessage } from '../base-cli-adapter';
import { CHROME_DEVTOOLS_MCP_VERSION } from '../../../browser-gateway/chrome-devtools-mcp-config';

const CHROME_DEVTOOLS_MCP_PACKAGE = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`;

function settingsPathOf(adapter: GeminiCliAdapter): string {
  const path = (adapter as unknown as {
    browserGatewaySettingsPath?: string;
  }).browserGatewaySettingsPath;
  expect(path).toBeTruthy();
  return path as string;
}

describe('adapter factory — gemini chrome-devtools attach', () => {
  const written: string[] = [];

  // The chrome-devtools MCP command is `npx` on POSIX and `cmd /c npx` on
  // Windows; pin POSIX so the canonical command is asserted regardless of host.
  const originalPlatform = process.platform;
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }));

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    for (const file of written.splice(0)) {
      try {
        rmSync(dirname(file), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('writes a settings file containing the chrome-devtools server when attach is set', () => {
    const adapter = createGeminiAdapter({
      workingDirectory: '/tmp',
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });
    const path = settingsPathOf(adapter);
    written.push(path);

    const settings = JSON.parse(readFileSync(path, 'utf-8'));
    expect(settings.mcpServers['chrome-devtools']).toMatchObject({
      command: 'npx',
      args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl', 'http://127.0.0.1:31234'],
    });
  });

  it('merges browser-gateway and chrome-devtools into a single settings file', () => {
    const adapter = createGeminiAdapter({
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
    const path = settingsPathOf(adapter);
    written.push(path);

    const settings = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      'browser-gateway',
      'chrome-devtools',
    ]);
  });

  it('delivers connector programs and remote servers in Gemini settings', () => {
    const adapter = createGeminiAdapter({
      workingDirectory: '/tmp',
      mcpConfig: [JSON.stringify({ mcpServers: {
        'linear-comtech': { command: 'PLACEHOLDER_COMMAND', args: ['connector', 'linear-comtech'] },
        remote: { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Example': 'PLACEHOLDER_VALUE' } },
      } })],
    });
    const path = settingsPathOf(adapter);
    written.push(path);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    expect(settings.mcpServers['linear-comtech']).toEqual({ command: 'PLACEHOLDER_COMMAND', args: ['connector', 'linear-comtech'] });
    expect(settings.mcpServers.remote).toEqual({ httpUrl: 'https://example.invalid/mcp', headers: { 'X-Example': 'PLACEHOLDER_VALUE' } });
  });

  it('resolves Gemini to its own CLI independently of Antigravity', () => {
    expect(mapSettingsToDetectionType('gemini')).toBe('gemini');
    expect(mapSettingsToDetectionType('antigravity')).toBe('antigravity');
  });
});

describe('GeminiCliAdapter T48 RTK wrap', () => {
  it('wraps every non-interactive prompt while resume stays unavailable', () => {
    const adapter = new GeminiCliAdapter({ rtkEnabled: true });
    expect(adapter.getRuntimeCapabilities().supportsResume).toBe(false);
    const access = adapter as unknown as { buildArgs(message: CliMessage): string[] };
    const first = access.buildArgs({ role: 'user', content: 'turn one' });
    const second = access.buildArgs({ role: 'user', content: 'turn two' });
    expect(first.some((arg) => arg.includes('[RTK AWARENESS]'))).toBe(true);
    expect(second.some((arg) => arg.includes('[RTK AWARENESS]'))).toBe(true);
  });
});
