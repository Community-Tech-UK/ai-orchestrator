import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeMcpAdapter } from '../claude-mcp-adapter';
import { CodexMcpAdapter } from '../codex-mcp-adapter';
import { CodexTomlEditor } from '../codex-toml-editor';
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
    expect(parsed.mcpServers.fs.command).toBe('npx');
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
