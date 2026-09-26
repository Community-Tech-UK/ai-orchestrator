import { describe, expect, it } from 'vitest';
import type { AcpMcpServerConfig } from '../../../../shared/types/cli.types';
import { filterSessionMcpServers } from '../acp-session-mcp-servers';

const STDIO: AcpMcpServerConfig = { name: 'lsp', command: 'node', args: ['lsp.js'] };
const HTTP: AcpMcpServerConfig = {
  name: 'http-server',
  type: 'http',
  url: 'https://mcp.example/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer x' }],
};
const SSE: AcpMcpServerConfig = {
  name: 'sse-server',
  type: 'sse',
  url: 'https://events.example/mcp',
  headers: [],
};

describe('filterSessionMcpServers', () => {
  it('always passes stdio servers', () => {
    for (const capabilities of [null, undefined, {}, { mcpCapabilities: {} }]) {
      expect(filterSessionMcpServers([STDIO], capabilities).servers).toEqual([STDIO]);
    }
  });

  it('gates HTTP/SSE entries on the advertised mcpCapabilities', () => {
    const both = { mcpCapabilities: { http: true, sse: true } };
    expect(filterSessionMcpServers([STDIO, HTTP, SSE], both).servers)
      .toEqual([STDIO, HTTP, SSE]);

    const httpOnly = { mcpCapabilities: { http: true } };
    const filtered = filterSessionMcpServers([STDIO, HTTP, SSE], httpOnly);
    expect(filtered.servers).toEqual([STDIO, HTTP]);
    expect(filtered.dropped).toEqual([{ name: 'sse-server', remoteType: 'sse' }]);

    const none = filterSessionMcpServers([STDIO, HTTP, SSE], null);
    expect(none.servers).toEqual([STDIO]);
    expect(none.dropped).toEqual([
      { name: 'http-server', remoteType: 'http' },
      { name: 'sse-server', remoteType: 'sse' },
    ]);
  });

  it('treats explicitly-false capability flags as unsupported', () => {
    const capabilities = { mcpCapabilities: { http: false, sse: false } };
    expect(filterSessionMcpServers([HTTP, SSE], capabilities).servers).toEqual([]);
  });
});
