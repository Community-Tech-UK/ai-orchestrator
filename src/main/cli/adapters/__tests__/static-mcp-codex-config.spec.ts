import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInlineMcpServersCodexConfigToml,
  buildStaticMcpServersCodexConfigToml,
} from '../static-mcp-codex-config';

const tmpDirs: string[] = [];
function writeStaticConfig(contents: string, name = 'mcp-servers.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-static-mcp-'));
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  tmpDirs.push(dir);
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildStaticMcpServersCodexConfigToml', () => {
  it('returns null when there are no entries', () => {
    expect(buildStaticMcpServersCodexConfigToml(undefined)).toBeNull();
    expect(buildStaticMcpServersCodexConfigToml([])).toBeNull();
  });

  it('converts stdio servers from config/mcp-servers.json into Codex TOML blocks', () => {
    const path = writeStaticConfig(
      JSON.stringify({
        mcpServers: {
          lsp: { command: 'node', args: ['/x/lsp/dist/index.js'] },
          imap: { command: 'node', args: ['/x/imap/dist/index.js'] },
        },
      }),
    );

    const toml = buildStaticMcpServersCodexConfigToml([path]) ?? '';

    expect(toml).toContain('[mcp_servers.lsp]');
    expect(toml).toContain('[mcp_servers.imap]');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/x/imap/dist/index.js"]');
    expect(toml.match(/startup_timeout_sec = 10/g)).toHaveLength(2);
    // stdio is Codex's default — no transport line for stdio servers.
    expect(toml).not.toContain('transport =');
  });

  it('preserves explicit startup and tool timeouts for stdio servers', () => {
    const path = writeStaticConfig(
      JSON.stringify({
        mcpServers: {
          lsp: {
            command: 'node',
            args: ['server.js'],
            startup_timeout_sec: 25,
            toolTimeoutSec: 90,
          },
        },
      }),
    );

    const toml = buildStaticMcpServersCodexConfigToml([path]) ?? '';
    expect(toml).toContain('startup_timeout_sec = 25');
    expect(toml).toContain('tool_timeout_sec = 90');
    expect(toml).not.toContain('startup_timeout_sec = 10');
  });

  it('ignores inline JSON bridge entries (browser-gateway, etc.)', () => {
    const inline = JSON.stringify({
      mcpServers: { 'browser-gateway': { command: 'node', args: ['bridge.js'] } },
    });
    expect(buildStaticMcpServersCodexConfigToml([inline])).toBeNull();
  });

  it('ignores config files that are not named mcp-servers.json', () => {
    const path = writeStaticConfig(
      JSON.stringify({ mcpServers: { x: { command: 'node' } } }),
      'codemem-bridge.json',
    );
    expect(buildStaticMcpServersCodexConfigToml([path])).toBeNull();
  });

  it('ignores non-existent paths', () => {
    expect(
      buildStaticMcpServersCodexConfigToml(['/no/such/mcp-servers.json']),
    ).toBeNull();
  });

  it('does not throw on malformed JSON', () => {
    const path = writeStaticConfig('{ not valid json');
    expect(buildStaticMcpServersCodexConfigToml([path])).toBeNull();
  });

  it('writes sse/http transport and env for non-stdio servers', () => {
    const path = writeStaticConfig(
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://example.com/mcp',
            transport: 'http',
            env: { TOKEN: 'abc' },
          },
        },
      }),
    );

    const toml = buildStaticMcpServersCodexConfigToml([path]) ?? '';
    expect(toml).toContain('[mcp_servers.remote]');
    expect(toml).toContain('url = "https://example.com/mcp"');
    expect(toml).toContain('transport = "http"');
    expect(toml).toContain('[mcp_servers.remote.env]');
    expect(toml).toContain('TOKEN = "abc"');
  });
});

describe('buildInlineMcpServersCodexConfigToml', () => {
  it('applies the bounded startup timeout to non-dedicated inline stdio servers', () => {
    const inline = JSON.stringify({
      mcpServers: {
        'orchestrator-tools': { command: 'node', args: ['orchestrator-tools.js'] },
      },
    });

    const toml = buildInlineMcpServersCodexConfigToml([inline]) ?? '';
    expect(toml).toContain('[mcp_servers.orchestrator-tools]');
    expect(toml).toContain('startup_timeout_sec = 10');
  });
});
