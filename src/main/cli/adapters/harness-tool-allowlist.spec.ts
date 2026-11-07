import { expect, it } from 'vitest';
import { HARNESS_READ_ONLY_TOOLS, harnessReadOnlyToolsFromCatalog } from './harness-tool-allowlist';
import { buildClaudeCliArgs } from './claude-cli-argv-builder';
it('derives exact read-only tool names from both live catalogs, fails on catalog drift', () => {
  expect(HARNESS_READ_ONLY_TOOLS).toHaveLength(11);
  expect(HARNESS_READ_ONLY_TOOLS).toContain('mcp__browser-gateway__browser_health');
  expect(HARNESS_READ_ONLY_TOOLS).toContain('mcp__orchestrator__get_setting');
  expect(HARNESS_READ_ONLY_TOOLS.some(name => /run_on_node|terminate_node_instance|computer-use|navigate|click|fill|tool_execute/.test(name))).toBe(false);
  expect(() => harnessReadOnlyToolsFromCatalog([], [])).toThrow(/catalog/i);
});
it('merges only those exact tools into ask-first argv, preserving custom tools and live prompts', () => {
  const args = buildClaudeCliArgs({ spawnOptions: { workingDirectory: '/tmp', yoloMode: false, allowedTools: ['Read'], residentClaude: true },
    sessionId: null, cliVersion: '2.1.300', excludeDynamicSectionsSupported: false, disallowedToolsOverride: null,
    shouldUseNativeResume: false, shouldUsePermissionHook: true, livePermissionPrompts: true, materializeInlineJsonArg: value => value });
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  expect(allowed).toEqual(['Read', ...HARNESS_READ_ONLY_TOOLS]);
  expect(args).toContain('--permission-prompt-tool');
});
