import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { createClaudeAdapter } from '../adapter-factory';
import { ClaudeCliAdapter } from '../claude-cli-adapter';
import { CHROME_DEVTOOLS_MCP_VERSION } from '../../../browser-gateway/chrome-devtools-mcp-config';

const CHROME_DEVTOOLS_MCP_PACKAGE = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`;
const materializedAdapters: ClaudeCliAdapter[] = [];

function buildArgs(adapter: ClaudeCliAdapter): string[] {
  materializedAdapters.push(adapter);
  return (
    adapter as unknown as {
      buildArgs(message: { role: 'user'; content: string }): string[];
    }
  ).buildArgs({ role: 'user', content: 'hello' });
}

function mcpConfigAt(args: string[], index: number): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(args[index], 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
}

describe('Claude CLI browser gate', () => {
  // Pin POSIX for the unwrapped npx command. Inline MCP JSON is materialized
  // to a private temp file on every platform.
  const originalPlatform = process.platform;
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }));
  afterEach(() => {
    for (const adapter of materializedAdapters.splice(0)) {
      (adapter as unknown as { cleanupInlineArgTempDir: () => void }).cleanupInlineArgTempDir();
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('does not pass --chrome by default', () => {
    const adapter = new ClaudeCliAdapter({});

    expect(buildArgs(adapter)).not.toContain('--chrome');
  });

  it('passes --chrome only when explicitly requested', () => {
    const adapter = new ClaudeCliAdapter({ chrome: true });

    expect(buildArgs(adapter)).toContain('--chrome');
  });

  it('injects Browser Gateway MCP config for Claude when bridge options are supplied', () => {
    const adapter = createClaudeAdapter({
      browserGatewayMcp: {
        aioMcpCliPath: '/tmp/aio-mcp',
        socketPath: '/tmp/browser-gateway.sock',
        instanceId: 'instance-browser',
        exists: () => true,
      },
    });

    const args = buildArgs(adapter);
    const mcpConfigIndex = args.indexOf('--mcp-config');
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    const config = mcpConfigAt(args, mcpConfigIndex + 1);
    expect(config.mcpServers['browser-gateway']).toMatchObject({
      command: '/tmp/aio-mcp',
      args: ['browser-gateway'],
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '/tmp/browser-gateway.sock',
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-browser',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'claude',
      },
    });
  });

  it('injects chrome-devtools attach MCP config for Claude from the dedicated option', () => {
    const adapter = createClaudeAdapter({
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });

    const args = buildArgs(adapter);
    const mcpConfigIndex = args.indexOf('--mcp-config');
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    const config = mcpConfigAt(args, mcpConfigIndex + 1);
    expect(config.mcpServers['chrome-devtools']).toEqual({
      command: 'npx',
      args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl', 'http://127.0.0.1:31234'],
    });
  });

  it('does not double-add chrome-devtools when it is already present in mcpConfig', () => {
    const adapter = createClaudeAdapter({
      mcpConfig: ['{"mcpServers":{"chrome-devtools":{"command":"npx"}}}'],
      chromeDevtoolsMcp: { browserUrl: 'http://127.0.0.1:31234' },
    });

    const args = buildArgs(adapter);
    const chromeDevtoolsConfigs = args
      .filter((arg) => arg.endsWith('.json'))
      .filter((arg) => readFileSync(arg, 'utf8').includes('"chrome-devtools"'));
    expect(chromeDevtoolsConfigs).toHaveLength(1);
  });

  it('refreshes MCP config on existing Claude adapters', () => {
    const adapter = new ClaudeCliAdapter({
      mcpConfig: ['{"mcpServers":{"old":{}}}'],
    });

    adapter.updateMcpConfig(['{"mcpServers":{"browser-gateway":{}}}']);

    const args = buildArgs(adapter);
    const mcpConfigIndex = args.indexOf('--mcp-config');
    expect(readFileSync(args[mcpConfigIndex + 1], 'utf8')).toBe('{"mcpServers":{"browser-gateway":{}}}');
  });

  it('normalizes every supported remote workspace connector for the final Claude argv', () => {
    const adapter = createClaudeAdapter({
      mcpConfig: [JSON.stringify({
        mcpServers: {
          'workspace-stdio': { command: 'npx', args: ['workspace-server'] },
          'workspace-http': { transport: 'http', url: 'https://example.test/mcp' },
          'workspace-sse': { transport: 'sse', url: 'https://example.test/events' },
        },
      })],
    });

    const args = buildArgs(adapter);
    const mcpConfigIndex = args.indexOf('--mcp-config');
    const config = mcpConfigAt(args, mcpConfigIndex + 1);
    expect(config.mcpServers).toMatchObject({
      'workspace-stdio': { command: 'npx', args: ['workspace-server'] },
      'workspace-http': { type: 'http', url: 'https://example.test/mcp' },
      'workspace-sse': { type: 'sse', url: 'https://example.test/events' },
    });
    expect(config.mcpServers['workspace-http']).not.toHaveProperty('transport');
    expect(config.mcpServers['workspace-sse']).not.toHaveProperty('transport');
  });
});
