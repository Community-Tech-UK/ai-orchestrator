import { describe, expect, it } from 'vitest';
import { preserveHarnessCliShellPolicy } from './codex-harness-shell-policy';

const bridge = {
  AIO_MCP: 'PLACEHOLDER_BINARY',
  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: 'PLACEHOLDER_SOCKET',
  AI_ORCHESTRATOR_INSTANCE_ID: 'PLACEHOLDER_INSTANCE',
  AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'PLACEHOLDER_CAPABILITY',
};

describe('preserveHarnessCliShellPolicy', () => {
  it('does not borrow ambient connection details when this spawn has no complete bridge', () => {
    const input = '[shell_environment_policy]\ninherit = "none"\n';
    expect(preserveHarnessCliShellPolicy(input)).toBe(input);
    for (const key of Object.keys(bridge)) {
      const incomplete: Record<string, string> = { ...bridge };
      delete incomplete[key];
      expect(preserveHarnessCliShellPolicy(input, incomplete)).toBe(input);
    }
  });

  it.each([
    '[shell_environment_policy]\ninherit = "core"\n',
    'shell_environment_policy.inherit = "core"\n',
    'shell_environment_policy = { inherit = "core", set = { USER_VALUE = "PLACEHOLDER_USER" } }\n',
    '["shell_environment_policy"] # comment\ninherit = "core"\n["shell_environment_policy"."set"]\nUSER_VALUE = "PLACEHOLDER_USER"\n',
  ])('preserves existing policy and user variables for supported table forms: %s', (input) => {
    const result = preserveHarnessCliShellPolicy(input, bridge);
    expect(result).toContain('inherit = "core"');
    if (input.includes('USER_VALUE')) expect(result).toContain('USER_VALUE = "PLACEHOLDER_USER"');
    expect(result).toContain('AIO_MCP = "PLACEHOLDER_BINARY"');
    expect(result).toContain('AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY = "PLACEHOLDER_CAPABILITY"');
    expect(preserveHarnessCliShellPolicy(result, bridge)).toBe(result);
  });

  it('replaces stale bridge values without replacing other user-defined variables', () => {
    const input = '[shell_environment_policy.set]\nAIO_MCP = "PLACEHOLDER_OLD"\nUSER_VALUE = "PLACEHOLDER_USER"\n';
    const result = preserveHarnessCliShellPolicy(input, bridge);
    expect(result).not.toContain('PLACEHOLDER_OLD');
    expect(result).toContain('AIO_MCP = "PLACEHOLDER_BINARY"');
    expect(result).toContain('USER_VALUE = "PLACEHOLDER_USER"');
  });

  it('keeps a trailing comma in an existing inline set table without adding another', () => {
    const input = 'shell_environment_policy = { inherit = "core", set = { USER_VALUE = "PLACEHOLDER_USER", } }\n';
    const result = preserveHarnessCliShellPolicy(input, bridge);
    expect(result).not.toMatch(/,\s*,/);
    expect(result).toContain('USER_VALUE = "PLACEHOLDER_USER",');
    expect(preserveHarnessCliShellPolicy(result, bridge)).toBe(result);
  });

  it('preserves comments after an inline-table trailing comma', () => {
    const input = 'shell_environment_policy = { inherit = "core", set = { USER_VALUE = "PLACEHOLDER_USER", # keep\n} }\n';
    const result = preserveHarnessCliShellPolicy(input, bridge);
    expect(result).not.toMatch(/, # keep\n, /);
    expect(preserveHarnessCliShellPolicy(result, bridge)).toBe(result);
  });

  it('keeps explicit excludes and extends an existing nonempty allow-only filter', () => {
    const input = '[shell_environment_policy]\ninherit = "none"\nexclude = ["AWS_*"]\ninclude_only = [\n  \'PATH\', # keep\n  "USER_VALUE",\n]\n';
    const result = preserveHarnessCliShellPolicy(input, bridge);
    expect(result).toContain('inherit = "none"');
    expect(result).toContain('exclude = ["AWS_*"]');
    expect(result).toContain('include_only = [\'PATH\', "USER_VALUE", "AIO_MCP", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET", "AI_ORCHESTRATOR_INSTANCE_ID", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY"]');
  });

  it('does not turn an empty allow-only array into a restriction', () => {
    const input = '[shell_environment_policy]\ninclude_only = []\n';
    expect(preserveHarnessCliShellPolicy(input, bridge)).toContain('include_only = []');
  });

  it('preserves unrelated multiline strings, table arrays, inline values and comments', () => {
    const unrelated = [
      'instructions = """',
      '[shell_environment_policy]',
      'set = "this is prose, not a setting"',
      '"""',
      'other = { quoted = " # [brackets] ", nested = { example = [1, 2] } }',
      '[[unrelated.items]]',
      'name = "PLACEHOLDER" # comment',
      '',
    ].join('\n');
    const result = preserveHarnessCliShellPolicy(unrelated, bridge);
    // The insertion is before the first actual table; the original bytes stay intact.
    expect(result.replace(/shell_environment_policy\.set\.[A-Z_]+ = "PLACEHOLDER_[A-Z]+"\n/g, '')).toBe(unrelated);
  });

  it('escapes bridge values as TOML strings without adding settings or arguments', () => {
    const result = preserveHarnessCliShellPolicy('', { ...bridge, AIO_MCP: 'PLACEHOLDER "quoted" \\path\nline' });
    expect(result).toContain('AIO_MCP = "PLACEHOLDER \\"quoted\\" \\\\path\\nline"');
  });

  it('refuses ambiguous or malformed policies instead of changing their inheritance', () => {
    for (const config of [
      '[shell_environment_policy]\ninclude_only = "PATH"',
      '[shell_environment_policy]\ninclude_only = [1]',
      '[shell_environment_policy]\ninclude_only = ["PATH"',
      '[shell_environment_policy]\ninherit = "unterminated',
    ]) expect(() => preserveHarnessCliShellPolicy(config, bridge)).toThrow('Could not preserve Codex shell policy');
  });
});
