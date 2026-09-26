import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeMcpAdapter } from '../claude-mcp-adapter';
import { CodexMcpAdapter } from '../codex-mcp-adapter';
import { CodexTomlEditor } from '../codex-toml-editor';
import { GrokMcpAdapter } from '../grok-mcp-adapter';
import { OpenCodeMcpAdapter } from '../opencode-mcp-adapter';
import { stripJsonc } from '../opencode-mcp-config';
import { WriteSafetyHelper } from '../../write-safety-helper';

describe('provider MCP adapters', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-provider-adapters-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Claude adapter reads and writes user MCP config without dropping other keys', async () => {
    const adapter = new ClaudeMcpAdapter({
      home: tmp,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    const configPath = path.join(tmp, '.claude.json');
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark', mcpServers: {} }));

    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile: configPath,
      record: {
        id: 'fs',
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y'],
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers['fs'].command).toBe('npx');
    const snapshot = await adapter.readScope('user', configPath);
    expect(snapshot.servers[0]?.name).toBe('fs');
  });

  it('Codex TOML editor preserves comments outside MCP sections', () => {
    const editor = new CodexTomlEditor();
    const input = [
      '# keep',
      'model = "gpt-5"',
      '',
      '[mcp_servers.old]',
      'command = "old"',
      '',
      '[profiles.default]',
      'approval = "never"',
    ].join('\n');
    const output = editor.upsertMcpServer(input, 'new', { command: 'node', args: ['server.js'] });
    expect(output).toContain('# keep');
    expect(output).toContain('[profiles.default]');
    expect(output).toContain('[mcp_servers.old]');
    expect(output).toContain('[mcp_servers.new]');
  });

  it('Codex TOML editor round-trips MCP startup and tool timeouts', () => {
    const editor = new CodexTomlEditor();
    const output = editor.upsertMcpServer('', 'lsp', {
      command: 'node',
      args: ['server.js'],
      startupTimeoutSec: 10,
      toolTimeoutSec: 120,
    });

    expect(output).toContain('startup_timeout_sec = 10');
    expect(output).toContain('tool_timeout_sec = 120');
    expect(editor.parseMcpServers(output)['lsp']).toMatchObject({
      startupTimeoutSec: 10,
      toolTimeoutSec: 120,
    });
  });

  it('Codex TOML editor removes nested MCP env and header tables', () => {
    const editor = new CodexTomlEditor();
    const input = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.old]',
      'command = "old"',
      '',
      '[mcp_servers.old.env]',
      'API_KEY = "secret"',
      '',
      '[mcp_servers.old.headers]',
      'Authorization = "Bearer secret"',
      '',
      '[profiles.default]',
      'approval = "never"',
    ].join('\n');

    const deleted = editor.deleteMcpServer(input, 'old');
    expect(deleted).not.toContain('[mcp_servers.old]');
    expect(deleted).not.toContain('API_KEY');
    expect(deleted).not.toContain('Authorization');
    expect(deleted).toContain('[profiles.default]');

    const stripped = editor.stripMcpServers(input);
    expect(stripped).not.toContain('mcp_servers.old');
    expect(stripped).not.toContain('API_KEY');
  });

  it('Codex TOML editor strips deeply-nested MCP sub-tables (e.g. tools.<name> per-tool approval)', () => {
    // Regression: Codex CLI 0.128+ supports `[mcp_servers.<name>.tools.<X>]`
    // approval tables. Without this, stripMcpServers left the orphan sub-table
    // behind, which Codex parsed as an implicit server with no transport and
    // rejected with "invalid transport in mcp_servers.<name>".
    const editor = new CodexTomlEditor();
    const input = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.claude-code]',
      'command = "/usr/local/bin/claude"',
      'args = ["mcp", "serve"]',
      '',
      '[mcp_servers.claude-code.tools.Read]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.claude-code.tools.Write]',
      'approval_mode = "approve"',
      '',
      '[profiles.default]',
      'approval = "never"',
    ].join('\n');

    const stripped = editor.stripMcpServers(input);
    expect(stripped).not.toContain('mcp_servers.claude-code');
    expect(stripped).not.toContain('approval_mode');
    expect(stripped).toContain('[profiles.default]');

    const deleted = editor.deleteMcpServer(input, 'claude-code');
    expect(deleted).not.toContain('mcp_servers.claude-code');
    expect(deleted).not.toContain('approval_mode');
    expect(deleted).toContain('[profiles.default]');
  });

  it('Codex TOML editor handles quoted server names with nested sub-tables', () => {
    const editor = new CodexTomlEditor();
    const input = [
      'model = "gpt-5"',
      '',
      '[mcp_servers."with-dash"]',
      'command = "node"',
      '',
      '[mcp_servers."with-dash".tools.Read]',
      'approval_mode = "approve"',
      '',
      '[profiles.default]',
      'approval = "never"',
    ].join('\n');
    const stripped = editor.stripMcpServers(input);
    expect(stripped).not.toContain('mcp_servers."with-dash"');
    expect(stripped).not.toContain('approval_mode');
    expect(stripped).toContain('[profiles.default]');
  });


  it('Codex TOML editor round-trips the enabled flag', () => {
    const editor = new CodexTomlEditor();
    const output = editor.upsertMcpServer('', 'lsp', { command: 'node', enabled: false });
    expect(output).toContain('[mcp_servers.lsp]');
    expect(editor.parseMcpServers(output)['lsp']).toMatchObject({ enabled: false });
    expect(editor.parseMcpServers('[mcp_servers.a]\ncommand = "x"\nenabled = true\n')['a'])
      .toMatchObject({ enabled: true });
    expect(editor.parseMcpServers('[mcp_servers.a]\ncommand = "x"\n')['a']?.enabled).toBeUndefined();
  });

  it('Codex TOML editor keeps values that contain " #" (comment strip is string-aware)', () => {
    // Regression: `rawLine.replace(/\s+#.*$/, '')` truncated any value with a
    // ` #` inside it, silently dropping the entry on parse.
    const editor = new CodexTomlEditor();
    const input = [
      '[mcp_servers.x]',
      'command = "node"',
      'description = "a # b"',
      'env = { P = "x # y" }',
    ].join('\n');
    expect(editor.parseMcpServers(input)['x']).toMatchObject({
      command: 'node',
      description: 'a # b',
      env: { P: 'x # y' },
    });
    // Full-line and trailing comments still strip.
    expect(editor.parseMcpServers('[mcp_servers.y]\ncommand = "c" # trailing\n')['y'])
      .toMatchObject({ command: 'c' });
  });

  it('Grok adapter reads and writes ~/.grok/config.toml, preserving other sections', async () => {
    const adapter = new GrokMcpAdapter({
      home: tmp,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    const configPath = path.join(tmp, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '# keep\n[ui]\ncompact_mode = false\n');
    expect((await adapter.discoverScopes({ cwd: tmp })).scopeFiles).toEqual({
      user: configPath,
      project: path.join(tmp, '.grok', 'config.toml'),
    });

    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile: configPath,
      record: {
        id: 'linear',
        name: 'linear',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote'],
        env: { TOKEN: 'abc' },
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const output = fs.readFileSync(configPath, 'utf8');
    expect(output).toContain('# keep');
    expect(output).toContain('[ui]');
    expect(output).toContain('[mcp_servers.linear]');
    expect(output).toContain('[mcp_servers.linear.env]');

    const snapshot = await adapter.readScope('user', configPath);
    expect(snapshot.servers[0]).toMatchObject({ name: 'linear', command: 'npx', args: ['-y', 'mcp-remote'] });

    await adapter.writeUserServer({ kind: 'delete', serverId: 'grok:user:linear', sourceFile: configPath });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('[mcp_servers.linear]');
    expect(fs.readFileSync(configPath, 'utf8')).toContain('[ui]');
  });

  it('Grok adapter reports a disabled server from `enabled = false`', async () => {
    const adapter = new GrokMcpAdapter({
      home: tmp,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    const configPath = path.join(tmp, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[mcp_servers.off]\ncommand = "x"\nenabled = false\n');
    const snapshot = await adapter.readScope('user', configPath);
    expect(snapshot.servers[0]).toMatchObject({ name: 'off', command: 'x', autoConnect: false });
  });

  it('Codex TOML editor maps autoConnect=false to enabled=false on write', () => {
    const editor = new CodexTomlEditor();
    expect(editor.toCodexServer({
      id: 'x',
      name: 'x',
      transport: 'stdio',
      command: 'node',
      autoConnect: false,
      createdAt: 1,
      updatedAt: 1,
    })).toMatchObject({ enabled: false });
    const output = editor.upsertMcpServer('', 'x', editor.toCodexServer({
      id: 'x',
      name: 'x',
      transport: 'stdio',
      command: 'node',
      autoConnect: false,
      createdAt: 1,
      updatedAt: 1,
    }));
    expect(output).toContain('enabled = false');
  });

  it('Codex TOML editor parses inline env and headers tables (Grok README form)', () => {
    const editor = new CodexTomlEditor();
    const input = [
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      'env = { GITHUB_TOKEN = "ghp_x", OTHER = "a,b" }',
      'headers = { "X-Header" = "value" }',
    ].join('\n');
    expect(editor.parseMcpServers(input)['github']).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_x', OTHER: 'a,b' },
      headers: { 'X-Header': 'value' },
    });

    // A UI edit must not strip the inline tables' data: it round-trips through
    // the sub-table form (semantically identical TOML).
    const rewritten = editor.upsertMcpServer(input, 'github', editor.toCodexServer({
      id: 'github',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_x', OTHER: 'a,b' },
      headers: { 'X-Header': 'value' },
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    }));
    expect(editor.parseMcpServers(rewritten)['github']).toMatchObject({
      env: { GITHUB_TOKEN: 'ghp_x', OTHER: 'a,b' },
      headers: { 'X-Header': 'value' },
    });
  });

  it('stripJsonc removes comments and trailing commas outside strings', () => {
    const raw = [
      '{',
      '  // line comment',
      '  "mcp": {',
      '    "a": { "type": "local", "command": ["node", "x.js"], }, /* block */',
      '    "note": "keep // and , and /* this */"',
      '  },',
      '}',
    ].join('\n');
    const parsed = JSON.parse(stripJsonc(raw)) as {
      mcp: Record<string, { command: string[] }>;
    };
    expect(parsed.mcp['a']?.command).toEqual(['node', 'x.js']);
    expect(parsed.mcp['note']).toBe('keep // and , and /* this */');
  });

  it('stripJsonc drops a trailing comma even when a comment sits between it and the closer', () => {
    // Regression: the comma look-ahead once skipped whitespace only, so
    // `{"a": 1, // note\n}` kept its comma and failed to parse.
    expect(() => JSON.parse(stripJsonc('{\n  "a": 1, // note\n}'))).not.toThrow();
    expect(() => JSON.parse(stripJsonc('{\n  "a": 1, /* note */\n}'))).not.toThrow();
    expect(() => JSON.parse(stripJsonc('{\n  "a": [1, 2,], // c\n  "b": 2,\n}'))).not.toThrow();
    expect(JSON.parse(stripJsonc('{\n  "a": 1, // note\n}'))).toEqual({ a: 1 });
    // A non-trailing comma followed by a comment must survive.
    expect(JSON.parse(stripJsonc('{\n  "a": 1, // c\n  "b": 2\n}'))).toEqual({ a: 1, b: 2 });
  });

  it('OpenCode adapter reads the mcp map (argv arrays, environment) and writes it back', async () => {
    const configDir = path.join(tmp, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, [
      '{',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "lsp": { "type": "local", "command": ["node", "lsp.js"], "environment": { "K": "v" }, "enabled": true },',
      '    "remote": { "type": "remote", "url": "https://mcp.example/mcp", "headers": { "X-A": "1" } },',
      '    "off": { "enabled": false }',
      '  }',
      '}',
    ].join('\n'));

    const adapter = new OpenCodeMcpAdapter({
      home: tmp,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    const { scopeFiles } = await adapter.discoverScopes({ cwd: path.join(tmp, 'proj') });
    expect(scopeFiles['user']).toBe(configPath);
    expect(scopeFiles['project']).toBe(path.join(tmp, 'proj', 'opencode.json'));

    const snapshot = await adapter.readScope('user', configPath);
    expect(snapshot.servers).toEqual([
      expect.objectContaining({ name: 'lsp', transport: 'stdio', command: 'node', args: ['lsp.js'], env: { K: 'v' }, autoConnect: true }),
      expect.objectContaining({ name: 'remote', transport: 'sse', url: 'https://mcp.example/mcp', headers: { 'X-A': '1' } }),
      expect.objectContaining({ name: 'off', autoConnect: false }),
    ]);

    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile: configPath,
      record: {
        id: 'imap',
        name: 'imap',
        transport: 'stdio',
        command: 'node',
        args: ['imap.js'],
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      $schema: string;
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(written.$schema).toBe('https://opencode.ai/config.json');
    expect(written.mcp['imap']).toEqual({ type: 'local', command: ['node', 'imap.js'] });
    expect(written.mcp['lsp']).toMatchObject({ type: 'local' });

    await adapter.writeUserServer({ kind: 'delete', serverId: 'opencode:user:imap', sourceFile: configPath });
    const afterDelete = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(afterDelete.mcp['imap']).toBeUndefined();
    expect(afterDelete.mcp['lsp']).toBeDefined();
  });

  it('OpenCode adapter prefers opencode.json when both config names exist', async () => {
    const configDir = path.join(tmp, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'opencode.json'), '{"mcp":{}}');
    fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{"mcp":{}}');
    const adapter = new OpenCodeMcpAdapter({
      home: tmp,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    const { scopeFiles } = await adapter.discoverScopes({ cwd: tmp });
    expect(scopeFiles['user']).toBe(path.join(configDir, 'opencode.json'));
  });

  it('Codex adapter reads and writes config.toml', async () => {
    const codexHome = path.join(tmp, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(configPath, '# keep\nmodel = "gpt-5"\n');
    const adapter = new CodexMcpAdapter({
      codexHome,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile: configPath,
      record: {
        id: 'gh',
        name: 'gh',
        transport: 'stdio',
        command: 'npx',
        args: ['-y'],
        autoConnect: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const output = fs.readFileSync(configPath, 'utf8');
    expect(output).toContain('# keep');
    expect(output).toContain('[mcp_servers.gh]');
    expect((await adapter.readScope('user', configPath)).servers[0]?.command).toBe('npx');
  });
});
