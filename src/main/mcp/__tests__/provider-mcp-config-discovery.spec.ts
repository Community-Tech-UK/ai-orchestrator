import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverProviderMcpServers,
  setProviderMcpServerEnabled,
} from '../provider-mcp-config-discovery';

describe('provider MCP config discovery — grok and opencode', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-mcp-discovery-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('discovers Grok `[mcp_servers]` tables with their enabled flag', async () => {
    const grokConfig = path.join(home, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(grokConfig), { recursive: true });
    fs.writeFileSync(grokConfig, [
      '[ui]',
      'compact_mode = false',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      'args = ["-y", "mcp-remote"]',
      '',
      '[mcp_servers.off]',
      'command = "x"',
      'enabled = false',
    ].join('\n'));

    const servers = await discoverProviderMcpServers();
    const linear = servers.find((server) => server.name === 'linear');
    expect(linear).toMatchObject({
      sourceProvider: 'grok',
      command: 'npx',
      args: ['-y', 'mcp-remote'],
      enabled: true,
    });
    expect(servers.find((server) => server.name === 'off')).toMatchObject({ enabled: false });
  });

  it('discovers OpenCode `mcp` entries (JSONC) in normalized shape', async () => {
    const configDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), [
      '{',
      '  // OpenCode global config',
      '  "mcp": {',
      '    "oc-lsp": { "type": "local", "command": ["node", "lsp.js"], "environment": { "K": "v" } },',
      '    "oc-remote": { "type": "remote", "url": "https://mcp.example/mcp" },',
      '  }',
      '}',
    ].join('\n'));

    const servers = await discoverProviderMcpServers();
    expect(servers.find((server) => server.name === 'oc-lsp')).toMatchObject({
      sourceProvider: 'opencode',
      command: 'node',
      args: ['lsp.js'],
      enabled: true,
    });
    expect(servers.find((server) => server.name === 'oc-remote')).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example/mcp',
    });
  });

  it('toggles Grok servers via the TOML enabled key', async () => {
    const grokConfig = path.join(home, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(grokConfig), { recursive: true });
    fs.writeFileSync(grokConfig, '[mcp_servers.linear]\ncommand = "npx"\n');

    const servers = await discoverProviderMcpServers();
    const linear = servers.find((server) => server.name === 'linear');
    expect(linear).toBeDefined();
    await setProviderMcpServerEnabled(linear!.id, false);

    const output = fs.readFileSync(grokConfig, 'utf8');
    expect(output).toContain('enabled = false');
    expect(servers.find((server) => server.name === 'linear')?.sourceProvider).toBe('grok');
    const toggled = (await discoverProviderMcpServers()).find((server) => server.name === 'linear');
    expect(toggled?.enabled).toBe(false);
  });

  it('replaces an existing no-space enabled=true instead of duplicating the key', async () => {
    // Regression: the match was `startsWith('enabled =')`, so `enabled=true`
    // was missed and a second (invalid-TOML) key was inserted.
    const grokConfig = path.join(home, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(grokConfig), { recursive: true });
    fs.writeFileSync(grokConfig, '[mcp_servers.linear]\ncommand = "npx"\nenabled=true\n');

    const linear = (await discoverProviderMcpServers()).find((server) => server.name === 'linear');
    await setProviderMcpServerEnabled(linear!.id, false);

    const output = fs.readFileSync(grokConfig, 'utf8');
    expect(output.match(/enabled\s*=/g)).toHaveLength(1);
    expect(output).toContain('enabled = false');
  });

  it('toggles a quoted dotted server name (mcp_servers."a.b")', async () => {
    // Regression: the header parser counted dots across the whole header, so a
    // quoted name containing a dot looked "nested" and the toggle threw.
    const grokConfig = path.join(home, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(grokConfig), { recursive: true });
    fs.writeFileSync(grokConfig, '[mcp_servers."a.b"]\ncommand = "npx"\n');

    const quoted = (await discoverProviderMcpServers()).find((server) => server.name === 'a.b');
    expect(quoted).toBeDefined();
    await setProviderMcpServerEnabled(quoted!.id, false);
    expect(fs.readFileSync(grokConfig, 'utf8')).toContain('enabled = false');
  });

  it('toggles OpenCode servers via the entry enabled flag', async () => {
    const configDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { 'oc-lsp': { type: 'local', command: ['node', 'lsp.js'] } },
    }));

    const servers = await discoverProviderMcpServers();
    const lsp = servers.find((server) => server.name === 'oc-lsp');
    expect(lsp).toBeDefined();
    await setProviderMcpServerEnabled(lsp!.id, false);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcp: Record<string, { enabled?: boolean }>;
    };
    expect(parsed.mcp['oc-lsp']?.enabled).toBe(false);
    const toggled = (await discoverProviderMcpServers()).find((server) => server.name === 'oc-lsp');
    expect(toggled?.enabled).toBe(false);
  });
});
