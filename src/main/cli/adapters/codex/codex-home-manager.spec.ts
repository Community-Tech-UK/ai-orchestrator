import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexHomeManager, stripMcpServers } from './codex-home-manager';

describe('stripMcpServers', () => {
  it('removes mcp server sections and preserves unrelated config', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      'args = ["playwright"]',
      '',
      '[profiles.default]',
      'approval_policy = "never"',
      '',
      '[mcp_servers.filesystem]',
      'command = "node"',
      '',
      '[history]',
      'persistence = "save-all"',
    ].join('\n');

    expect(stripMcpServers(config)).toBe([
      'model = "gpt-5.3-codex"',
      '',
      '[profiles.default]',
      'approval_policy = "never"',
      '',
      '[history]',
      'persistence = "save-all"',
    ].join('\n'));
  });
});

describe('CodexHomeManager', () => {
  const originalHome = process.env['HOME'];
  const tempRoots: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a temporary CODEX_HOME with only the injected Browser Gateway MCP config', () => {
    const home = join(tmpdir(), `codex-home-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(home);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), '{"token":"existing"}', 'utf-8');
    writeFileSync(join(codexDir, 'config.toml'), [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-mcp"',
    ].join('\n'), 'utf-8');
    process.env['HOME'] = home;

    const manager = new CodexHomeManager();
    const generated = manager.prepareHomeWithMcpConfig([
      '[mcp_servers."browser-gateway"]',
      'command = "app"',
      'args = ["browser-mcp-stdio-server.js"]',
    ].join('\n'));

    expect(generated).toBeTruthy();
    expect(existsSync(join(generated!, 'auth.json'))).toBe(true);
    expect(readFileSync(join(generated!, 'config.toml'), 'utf-8')).toBe([
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers."browser-gateway"]',
      'command = "app"',
      'args = ["browser-mcp-stdio-server.js"]',
    ].join('\n'));

    manager.cleanup();
    expect(existsSync(generated!)).toBe(false);
  });
});
