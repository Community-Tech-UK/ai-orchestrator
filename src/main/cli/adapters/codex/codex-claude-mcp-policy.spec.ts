import { describe, expect, it } from 'vitest';
import { disableClaudeCallbackTools } from './codex-claude-mcp-policy';

describe('Claude callback tools in generated Codex configuration', () => {
  it('supports native Codex TOML 1.1 escapes and multiline inline tables with trailing commas', () => {
    const config = String.raw`mcp_servers.fixture = {
command = "claude",
args = ["mcp", "serve", "\e", "\x1b"],
}
`;
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('disabled_tools = ["Monitor", "ScheduleWakeup"');
    expect(filtered).toContain(String.raw`args = ["mcp", "serve", "\e", "\x1b"],`);
    expect(disableClaudeCallbackTools(filtered)).toBe(filtered);
  });
  it('handles prototype-like server names and decoded keys without mutating object prototypes', () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const config = String.raw`mcp_servers."__proto__" = { "com\u006dand" = "claude", args = ["mcp", "serve"] }
mcp_servers.constructor.command = "claude"
mcp_servers.constructor.args = ["mcp", "serve"]
unrelated.__proto__.codexPolicyProbe = "keep me"
`;
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered.match(/"Monitor", "ScheduleWakeup"/g)).toHaveLength(2);
    expect(filtered).toContain('unrelated.__proto__.codexPolicyProbe = "keep me"');
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    expect(disableClaudeCallbackTools(filtered)).toBe(filtered);
  });
  it.each([
    ['root dotted inline', 'mcp_servers.fixture = { command = "claude", args = ["mcp", "serve"], unknown = "keep me" }\n'],
    ['parent table inline', '[mcp_servers]\nfixture = { command = "claude", args = ["mcp", "serve"], unknown = "keep me" }\n'],
    ['root nested inline', 'mcp_servers = { fixture = { command = "claude", args = ["mcp", "serve"], unknown = "keep me" } }\n'],
    ['root dotted leaves', 'mcp_servers.fixture.command = "claude"\nmcp_servers.fixture.args = ["mcp", "serve"]\nmcp_servers.fixture.unknown = "keep me"\n'],
    ['parent dotted leaves', '[mcp_servers]\nfixture.command = "claude"\nfixture.args = ["mcp", "serve"]\nfixture.unknown = "keep me"\n'],
    ['inline dotted leaves', 'mcp_servers = { fixture.command = "claude", fixture.args = ["mcp", "serve"], fixture.unknown = "keep me" }\n'],
    ['quoted dotted inline', '"mcp_servers"."fixture.name" = { "command" = "claude", \'args\' = ["mcp", "serve"], unknown = "keep me" }\n'],
    ['existing inline denial', 'mcp_servers.fixture = { command = "claude", args = ["mcp", "serve"], disabled_tools = ["Existing"], unknown = "keep me" }\n'],
  ])('filters the native-valid %s representation without rewriting unrelated text', (_name, config) => {
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('"Monitor", "ScheduleWakeup"');
    expect(filtered).toContain('unknown = "keep me"');
    expect(disableClaudeCallbackTools(filtered)).toBe(filtered);
    expect(filtered.replace(/(?:[A-Za-z_".]+\.)?disabled_tools = \[(?:"[^"]+"(?:, )?)+\](?:, |\n)?/, '')).toBe(
      config.replace(/disabled_tools = \["Existing"\], /, ''),
    );
  });
  it('preserves an unrelated server with legitimate TOML Unicode escapes', () => {
    const config = String.raw`[mcp_servers.other]
command = "node"
args = ["\U0001F600"]
`;
    expect(disableClaudeCallbackTools(config)).toBe(config);
  });

  it('recognizes quoted keys and table names without changing their spelling', () => {
    const config = '["mcp_servers"."claude]server"] # ] in a comment\n"command" = "claude"\n\'args\' = ["mcp", "serve"]\n';
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('["mcp_servers"."claude]server"] # ] in a comment');
    expect(filtered).toContain('disabled_tools = ["Monitor"');
  });

  it('filters Claude callback tools when command, arguments and existing tools use TOML Unicode escapes', () => {
    const config = String.raw`[mcp_servers.claude]
command = "\U00000063laude"
args = ["\U0000006Dcp", "\u0073erve", "\U0001F600"]
disabled_tools = ["Existing\U0001F600"]
`;
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('disabled_tools = ["Existing😀", "Monitor", "ScheduleWakeup"');
    expect(filtered).toContain(String.raw`args = ["\U0000006Dcp", "\u0073erve", "\U0001F600"]`);
  });

  it('reads multiline basic and literal TOML strings without treating their contents as config', () => {
    const config = String.raw`[mcp_servers.claude]
description = '''
[mcp_servers.unrelated]
command = "node"
'''
command = """
clau\
  de"""
args = ["""
m\
 cp""", '''serve''', '''literal \U0001F600 [ ] # text''']
disabled_tools = ["""Existing\U0001F600""", '''Literal\U0001F600''']
`;
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('disabled_tools = ["Existing😀", "Literal\\\\U0001F600", "Monitor"');
    expect(filtered).toContain('description =');
    expect(filtered).toContain('[mcp_servers.unrelated]\ncommand = "node"');
    expect(disableClaudeCallbackTools(filtered)).toBe(filtered);
  });
  it('handles comments and quoted brackets while retaining existing disabled tools', () => {
    const config = '[mcp_servers.claude]\ncommand = "claude"\nargs = ["--label", "# ]", "mcp", "serve"]\ndisabled_tools = [\n"Existing]Tool", # "comment is not a tool"\n]\n';
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('disabled_tools = ["Existing]Tool", "Monitor"');
    expect(filtered).not.toContain('"comment is not a tool"');
    expect(filtered).toContain('args = ["--label", "# ]", "mcp", "serve"]');
  });
  it('adds a deny list for a literal-quoted Windows Claude executable and remains idempotent', () => {
    const config = "[mcp_servers.claude]\ncommand = 'C:\\Tools\\claude.exe'\nargs = ['mcp', 'serve']\n";
    const filtered = disableClaudeCallbackTools(config);
    expect(filtered).toContain('disabled_tools = ["Monitor", "ScheduleWakeup"');
    expect(filtered).toContain("command = 'C:\\Tools\\claude.exe'");
    expect(disableClaudeCallbackTools(filtered)).toBe(filtered);
  });

  it.each([
    '[mcp_servers.other]\ncommand = "node"\nargs = ["mcp", "serve"]\n',
    '[mcp_servers.claude]\ncommand = "claude"\nargs = ["mcp", "list"]\n',
    '[mcp_servers.claude]\nurl = "https://example.invalid/mcp"\n',
  ])('preserves unrelated server configuration verbatim', (config) => {
    expect(disableClaudeCallbackTools(config)).toBe(config);
  });
});
