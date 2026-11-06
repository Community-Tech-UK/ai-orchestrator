import { readFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('spawn-config-builder bundled MCP asset', () => {
  it('parses the real bundled config and keeps IMAP command and args', () => {
    const config = JSON.parse(readFileSync(new URL('../../../../config/mcp-servers.json', pathToFileURL(__filename)), 'utf8'));
    expect(config.mcpServers.imap.command).toEqual(expect.any(String));
    expect(config.mcpServers.imap.command.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(config.mcpServers.imap.args)).toBe(true);
    expect(config.mcpServers.imap.args.length).toBeGreaterThan(0);
    expect(config.mcpServers.imap.args.every((arg: unknown) => typeof arg === 'string')).toBe(true);
  });
});
