import { readFileSync, rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter } from '../adapter-factory';
import type { GeminiCliAdapter } from '../gemini-cli-adapter';
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
        rmSync(file, { force: true });
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
});
