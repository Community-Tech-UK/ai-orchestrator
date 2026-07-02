import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexHomeManager, stripMcpServers, sweepStaleCodexTempHomes } from './codex-home-manager';

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

describe('sweepStaleCodexTempHomes', () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSandbox(): string {
    const dir = join(tmpdir(), `codex-sweep-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    sandboxes.push(dir);
    return dir;
  }

  function makeAgedDir(base: string, name: string, ageMs: number): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const aged = new Date(Date.now() - ageMs);
    utimesSync(dir, aged, aged);
    return dir;
  }

  it('removes stale codex temp homes and keeps fresh ones', () => {
    const base = makeSandbox();
    const staleNoMcp = makeAgedDir(base, 'codex-nomcp-abc123', 48 * 60 * 60 * 1000);
    const staleBrowser = makeAgedDir(base, 'codex-browser-mcp-def456', 48 * 60 * 60 * 1000);
    const fresh = makeAgedDir(base, 'codex-browser-mcp-fresh', 0);
    const unrelated = makeAgedDir(base, 'some-other-dir', 48 * 60 * 60 * 1000);

    const removed = sweepStaleCodexTempHomes(24 * 60 * 60 * 1000, base);

    expect(removed).toBe(2);
    expect(existsSync(staleNoMcp)).toBe(false);
    expect(existsSync(staleBrowser)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('ignores matching non-directory entries', () => {
    const base = makeSandbox();
    const filePath = join(base, 'codex-nomcp-file');
    writeFileSync(filePath, 'not a dir', 'utf-8');
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(filePath, aged, aged);

    expect(sweepStaleCodexTempHomes(24 * 60 * 60 * 1000, base)).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it('never throws for a missing base directory', () => {
    expect(sweepStaleCodexTempHomes(0, join(tmpdir(), 'codex-sweep-spec-missing'))).toBe(0);
  });
});
