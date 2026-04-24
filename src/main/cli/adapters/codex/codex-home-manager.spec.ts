import { describe, expect, it } from 'vitest';
import { stripMcpServers } from './codex-home-manager';

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
