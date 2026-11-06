import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildInlineMcpServersAcpMcpServers,
} from '../../cli/adapters/acp-mcp-server-convert';
import {
  buildInlineMcpServersCodexConfigToml,
  buildStaticMcpServersCodexConfigToml,
} from '../../cli/adapters/static-mcp-codex-config';
import { mcpServersSkippedForRole, staticMcpConfigEntries } from './mcp-role-policy';

const STATIC_SERVERS = {
  mcpServers: {
    lsp: { command: 'node', args: ['/x/lsp/index.js'], env: { LSP_MODE: 'fast' } },
    imap: { command: 'node', args: ['/x/imap/index.js'] },
  },
};

describe('mcpServersSkippedForRole', () => {
  it.each(['verifier', 'triage'])('skips the four expensive servers for the queue %s', (role) => {
    expect([...mcpServersSkippedForRole({ metadata: { planQueueRole: role } })].sort())
      .toEqual(['browser', 'codemem', 'desktop', 'imap']);
  });

  it.each([
    ['queue worker', { metadata: { planQueueRole: 'worker' } }],
    ['ordinary session', { metadata: {} }],
    ['session without metadata', {}],
    ['unknown instance', undefined],
    ['unknown role string', { metadata: { planQueueRole: 'reviewer' } }],
    ['non-string role', { metadata: { planQueueRole: 7 } }],
  ])('leaves a %s unchanged', (_label, subject) => {
    expect(mcpServersSkippedForRole(subject).size).toBe(0);
  });
});

describe('staticMcpConfigEntries', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-role-policy-'));
    configPath = join(dir, 'mcp-servers.json');
    writeFileSync(configPath, JSON.stringify(STATIC_SERVERS));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hands over the file itself when nothing is skipped', () => {
    expect(staticMcpConfigEntries(configPath, new Set())).toEqual([configPath]);
  });

  it('hands over an inline copy without imap when imap is skipped', () => {
    const entries = staticMcpConfigEntries(configPath, new Set(['imap']));
    expect(entries).toHaveLength(1);
    expect(entries[0].startsWith('{')).toBe(true);
    expect(JSON.parse(entries[0])).toEqual({ mcpServers: { lsp: STATIC_SERVERS.mcpServers.lsp } });
  });

  it('hands over nothing when every server in the file is skipped', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { imap: STATIC_SERVERS.mcpServers.imap } }));
    expect(staticMcpConfigEntries(configPath, new Set(['imap']))).toEqual([]);
  });

  it.each(['not json', '{"mcpServers": 3}', '[]'])('hands over nothing for an unusable file (%s)', (text) => {
    writeFileSync(configPath, text);
    expect(staticMcpConfigEntries(configPath, new Set(['imap']))).toEqual([]);
  });

  it('only skips the server named exactly imap', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { ...STATIC_SERVERS.mcpServers, 'imap-archive': { command: 'node' } } }));
    const servers = JSON.parse(staticMcpConfigEntries(configPath, new Set(['imap']))[0]).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(['imap-archive', 'lsp']);
  });

  it('reaches Codex and ACP providers through their inline-config paths, keeping lsp and dropping imap', () => {
    const entries = staticMcpConfigEntries(configPath, new Set(['imap']));
    const toml = buildInlineMcpServersCodexConfigToml(entries) ?? '';
    expect(toml).toContain('[mcp_servers.lsp]');
    expect(toml).not.toContain('imap');
    // The static-file converter only recognises the file by name, so it must not double-inject.
    expect(buildStaticMcpServersCodexConfigToml(entries)).toBeNull();
    expect(buildInlineMcpServersAcpMcpServers(entries).map(server => server.name)).toEqual(['lsp']);
  });
});
