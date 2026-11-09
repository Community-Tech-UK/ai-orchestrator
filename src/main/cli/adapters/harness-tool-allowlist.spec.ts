import { expect, it } from 'vitest';
import { HARNESS_ALLOWED_TOOLS, HELD_ORCHESTRATOR_TOOL_MATCHER, harnessAllowedToolsFromCatalog, heldOrchestratorToolMatcher } from './harness-tool-allowlist';
import { buildClaudeCliArgs } from './claude-cli-argv-builder';

it('derives exact allowed tool names from both live catalogs, fails on catalog drift', () => {
  expect(HARNESS_ALLOWED_TOOLS).toHaveLength(13);
  expect(HARNESS_ALLOWED_TOOLS).toContain('mcp__browser-gateway__browser_health');
  expect(HARNESS_ALLOWED_TOOLS).toContain('mcp__orchestrator__get_setting');
  // A scheduled job must always be able to report, and a run's parent to read its status.
  expect(HARNESS_ALLOWED_TOOLS).toEqual(expect.arrayContaining(['mcp__orchestrator__automation_result', 'mcp__orchestrator__plan_queue_status']));
  expect(HARNESS_ALLOWED_TOOLS.some(name => /run_on_node|terminate_node_instance|computer-use|navigate|click|fill|tool_execute|plan_queue_(?!status)|set_setting/.test(name))).toBe(false);
  expect(() => harnessAllowedToolsFromCatalog([], [])).toThrow(/catalog/i);
});

it('holds every orchestrator tool that is not allowed, including ones added later, and nothing else', () => {
  const held = (tool: string) => new RegExp(HELD_ORCHESTRATOR_TOOL_MATCHER).test(tool);
  expect(held('mcp__orchestrator__plan_queue_start')).toBe(true);
  expect(held('mcp__orchestrator__plan_queue_control')).toBe(true);
  expect(held('mcp__orchestrator__plan_queue_answer')).toBe(true);
  expect(held('mcp__orchestrator__a_tool_added_next_month')).toBe(true);
  for (const tool of HARNESS_ALLOWED_TOOLS) expect(held(tool)).toBe(false);
  // Exact names only: an allowed name is not a prefix that frees a longer one.
  expect(held('mcp__orchestrator__plan_queue_status_extra')).toBe(true);
  expect(held('mcp__browser-gateway__browser_click')).toBe(false);
  expect(held('Bash')).toBe(false);
  expect(new RegExp(heldOrchestratorToolMatcher(['mcp__orchestrator__a.b'])).test('mcp__orchestrator__aXb')).toBe(true);
});

it('merges only those exact tools into ask-first argv, preserving custom tools and live prompts', () => {
  const args = buildClaudeCliArgs({ spawnOptions: { workingDirectory: '/tmp', yoloMode: false, allowedTools: ['Read'], residentClaude: true },
    sessionId: null, cliVersion: '2.1.300', excludeDynamicSectionsSupported: false, disallowedToolsOverride: null,
    shouldUseNativeResume: false, shouldUsePermissionHook: true, livePermissionPrompts: true, materializeInlineJsonArg: value => value });
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  expect(allowed).toEqual(['Read', ...HARNESS_ALLOWED_TOOLS]);
  expect(args).toContain('--permission-prompt-tool');
});
