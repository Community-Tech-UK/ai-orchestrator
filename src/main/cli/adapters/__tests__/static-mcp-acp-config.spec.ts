import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { completeAcpMcpServer } from '../acp-mcp-server-convert';
import { buildStaticMcpServersAcpMcpServers } from '../static-mcp-acp-config';

describe('completeAcpMcpServer', () => {
  it('fills the stdio arrays OpenCode requires when a server omitted them', () => {
    expect(completeAcpMcpServer({ name: 'lsp', command: 'node', args: ['lsp.js'] })).toEqual({
      name: 'lsp',
      command: 'node',
      args: ['lsp.js'],
      env: [],
    });
    expect(completeAcpMcpServer({ name: 'bare', command: 'node' })).toEqual({
      name: 'bare',
      command: 'node',
      args: [],
      env: [],
    });
  });

  it('fills an empty headers array on remote servers and leaves other servers alone', () => {
    expect(completeAcpMcpServer({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example/mcp',
    })).toEqual({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example/mcp',
      headers: [],
    });
    expect(completeAcpMcpServer({ name: 'unnamed' })).toEqual({ name: 'unnamed' });
  });
});

describe('buildStaticMcpServersAcpMcpServers', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-mcp-acp-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeStaticConfig(contents: string, name = 'mcp-servers.json'): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it('converts stdio servers from config/mcp-servers.json into ACP servers', () => {
    const filePath = writeStaticConfig(JSON.stringify({
      mcpServers: {
        lsp: { command: 'node', args: ['/x/lsp/index.js'] },
        imap: { command: 'node', args: ['/x/imap/index.js'], env: { IMAP_HOST: 'h' } },
      },
    }));

    expect(buildStaticMcpServersAcpMcpServers([filePath])).toEqual([
      { name: 'lsp', command: 'node', args: ['/x/lsp/index.js'], env: [] },
      {
        name: 'imap',
        command: 'node',
        args: ['/x/imap/index.js'],
        env: [{ name: 'IMAP_HOST', value: 'h' }],
      },
    ]);
  });

  it('skips inline JSON entries, other file names, and dedicated bridge servers', () => {
    const filePath = writeStaticConfig(JSON.stringify({
      mcpServers: {
        'browser-gateway': { command: 'x' },
        lsp: { command: 'node' },
      },
    }));
    const otherFile = writeStaticConfig(
      JSON.stringify({ mcpServers: { nope: { command: 'x' } } }),
      'other.json',
    );
    const inline = JSON.stringify({ mcpServers: { bridge: { command: 'y' } } });

    const servers = buildStaticMcpServersAcpMcpServers([inline, otherFile, filePath]);
    expect(servers.map((server) => server.name)).toEqual(['lsp']);
  });

  it('converts remote entries to capability-gated ACP http/sse form', () => {
    const filePath = writeStaticConfig(JSON.stringify({
      mcpServers: {
        remote: { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } },
        explicitHttp: { transport: 'http', url: 'https://h.example/mcp' },
        good: { command: 'node' },
      },
    }));

    expect(buildStaticMcpServersAcpMcpServers([filePath])).toEqual([
      {
        name: 'remote',
        type: 'sse',
        url: 'https://mcp.example/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer x' }],
      },
      {
        name: 'explicitHttp',
        type: 'http',
        url: 'https://h.example/mcp',
        headers: [],
      },
      { name: 'good', command: 'node', args: [], env: [] },
    ]);
  });

  it('skips malformed files and entries with neither command nor url instead of failing the spawn', () => {
    const filePath = writeStaticConfig(JSON.stringify({
      mcpServers: {
        broken: { args: ['x'] },
        good: { command: 'node' },
      },
    }));
    const broken = writeStaticConfig('{ not json', 'mcp-servers.json.aux');
    // A broken file with the right basename must not throw.
    const brokenNamed = path.join(dir, 'nested');
    fs.mkdirSync(brokenNamed);
    fs.writeFileSync(path.join(brokenNamed, 'mcp-servers.json'), '{ not json');

    const servers = buildStaticMcpServersAcpMcpServers([
      filePath,
      broken,
      path.join(brokenNamed, 'mcp-servers.json'),
    ]);
    expect(servers.map((server) => server.name)).toEqual(['good']);
  });

  it('returns an empty list when there is no static config', () => {
    expect(buildStaticMcpServersAcpMcpServers(undefined)).toEqual([]);
    expect(buildStaticMcpServersAcpMcpServers(['{"mcpServers":{}}'])).toEqual([]);
    expect(buildStaticMcpServersAcpMcpServers([path.join(dir, 'mcp-servers.json')])).toEqual([]);
  });
});
