/**
 * Regression for 8 November 2026: a scheduled Claude session (Auto-approve off)
 * had every orchestrator tool call refused at once, and approving the card could
 * not let the waiting call run.
 *
 * Builds the real argv Harness uses for a scheduled session and runs the real
 * hook scripts in the order Claude Code 2.1.319 applies them (measured against
 * the real CLI, see docs/plans/2026-11-08-scheduled-session-tool-approvals_plan.md):
 * matching PreToolUse hooks first; with no decision, `--allowedTools` decides;
 * a call that would still need asking goes to PermissionRequest hooks; with no
 * answer there, Claude refuses it. Claude applies the same path to a tool listed
 * from the start and to one loaded through ToolSearch.
 */
import { execSync } from 'child_process';
import { rmSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeCliArgs } from '../../adapters/claude-cli-argv-builder';
import { HARNESS_UNASKED_PREFIX, harnessRefusal } from '../../adapters/claude-permission-response';
import { extractPermissionDetails, isPermissionDenialContent } from '../../adapters/claude-cli-permission-details';
import { ORCHESTRATOR_CORE_TOOL_NAMES } from '../../../mcp/orchestrator-mcp-deferral';
import { DeferDecisionStore } from '../defer-decision-store';

type Entry = { matcher: string; hooks: { command: string }[] };
type Outcome = { runs: true } | { held: true } | { refused: string };

const HOOKS = ['defer-permission-hook.mjs', 'rtk-defer-hook.mjs'];

function scheduledSessionArgs(hookFile: string): string[] {
  return buildClaudeCliArgs({
    spawnOptions: {
      workingDirectory: '/tmp/project', yoloMode: false, residentClaude: true, machineSession: 'automation',
      permissionHookPath: path.join(process.cwd(), 'src', 'main', 'cli', 'hooks', hookFile),
    },
    sessionId: null, cliVersion: '2.1.319', excludeDynamicSectionsSupported: false, disallowedToolsOverride: null,
    shouldUseNativeResume: false, shouldUsePermissionHook: true, livePermissionPrompts: false,
    materializeInlineJsonArg: value => value,
  });
}

// Through a shell on purpose: Claude runs the hook command string exactly as Harness wrote it into --settings,
// so this also covers its quoting. Every input here is fixed by the test.
function runHook(command: string, payload: Record<string, unknown>, decisionDir?: string): Record<string, unknown> | null {
  // Pin the hook modes: a Harness session running this spec may export the auto-approve rewrite-only mode.
  const env = { ...process.env, ORCHESTRATOR_RTK_ENABLED: '0', ORCHESTRATOR_RTK_REWRITE_ONLY: '0', ...(decisionDir ? { ORCHESTRATOR_DECISION_DIR: decisionDir } : {}) };
  if (!decisionDir) delete env['ORCHESTRATOR_DECISION_DIR'];
  const stdout = execSync(command, { input: JSON.stringify(payload), encoding: 'utf8', env });
  return stdout.trim() ? JSON.parse(stdout) as Record<string, unknown> : null;
}

/** Claude Code's order: PreToolUse hooks, then the allow list, then PermissionRequest hooks, then refusal. */
function callTool(args: string[], toolName: string, toolUseId: string, decisionDir?: string): Outcome {
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as { hooks: { PreToolUse: Entry[]; PermissionRequest?: Entry[] } };
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  const payload = { tool_name: toolName, tool_use_id: toolUseId, tool_input: { note: 'x' }, permission_mode: 'acceptEdits' };
  for (const entry of settings.hooks.PreToolUse.filter(item => new RegExp(item.matcher).test(toolName))) {
    const reply = runHook(entry.hooks[0].command, { ...payload, hook_event_name: 'PreToolUse' }, decisionDir);
    const output = reply?.['hookSpecificOutput'] as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    if (output?.permissionDecision === 'defer') return { held: true };
    if (output?.permissionDecision === 'allow') return { runs: true };
    if (output?.permissionDecision === 'deny') return { refused: output.permissionDecisionReason ?? '' };
  }
  if (allowed.includes(toolName)) return { runs: true };
  for (const entry of (settings.hooks.PermissionRequest ?? []).filter(item => new RegExp(item.matcher).test(toolName))) {
    const reply = runHook(entry.hooks[0].command, { ...payload, hook_event_name: 'PermissionRequest' });
    const decision = (reply?.['hookSpecificOutput'] as { decision?: { behavior: string; message?: string } } | undefined)?.decision;
    if (decision?.behavior === 'deny') return { refused: decision.message ?? '' };
  }
  return { refused: `Claude requested permissions to use ${toolName}, but you haven't granted it yet.` };
}

describe.each(HOOKS)('a scheduled Claude session calling Harness tools (%s)', (hookFile) => {
  const written: string[] = [];
  afterEach(() => {
    // The decision folder is shared with a running Harness: remove only this test's files, never the folder.
    for (const file of written.splice(0)) rmSync(file, { force: true });
  });

  it('runs automation_result, which the orchestrator server lists from the start', () => {
    expect(ORCHESTRATOR_CORE_TOOL_NAMES).toContain('automation_result');
    expect(callTool(scheduledSessionArgs(hookFile), 'mcp__orchestrator__automation_result', 'toolu_result')).toEqual({ runs: true });
  });

  it('runs plan_queue_status, which is found through tool search, without asking', () => {
    expect(ORCHESTRATOR_CORE_TOOL_NAMES).not.toContain('plan_queue_status');
    expect(callTool(scheduledSessionArgs(hookFile), 'mcp__orchestrator__plan_queue_status', 'toolu_status')).toEqual({ runs: true });
  });

  it('holds plan_queue_start, found through tool search, until approved, then runs the same waiting call', () => {
    expect(ORCHESTRATOR_CORE_TOOL_NAMES).not.toContain('plan_queue_start');
    const args = scheduledSessionArgs(hookFile);
    const toolUseId = `toolu_sched_approve_${process.pid}_${Date.now()}`;
    expect(callTool(args, 'mcp__orchestrator__plan_queue_start', toolUseId)).toEqual({ held: true });

    // Approving the card writes the decision the resumed CLI's hook reads for that same call.
    const store = DeferDecisionStore.getInstance();
    store.writeDecision(toolUseId, 'allow', 'User approved via orchestrator UI');
    written.push(path.join(store.getDecisionDir(), `${toolUseId}.json`));
    expect(callTool(args, 'mcp__orchestrator__plan_queue_start', toolUseId, store.getDecisionDir())).toEqual({ runs: true });
  });

  it('tells the model when a held call was refused by policy rather than by a person', () => {
    const args = scheduledSessionArgs(hookFile);
    const toolUseId = `toolu_sched_rule_${process.pid}_${Date.now()}`;
    expect(callTool(args, 'mcp__orchestrator__plan_queue_control', toolUseId)).toEqual({ held: true });
    const store = DeferDecisionStore.getInstance();
    store.writeDecision(toolUseId, 'deny', harnessRefusal({ autoReason: 'a saved rule refuses it.' }, 'User denied via orchestrator UI'));
    written.push(path.join(store.getDecisionDir(), `${toolUseId}.json`));
    const outcome = callTool(args, 'mcp__orchestrator__plan_queue_control', toolUseId, store.getDecisionDir());
    expect(outcome).toEqual({ refused: `${HARNESS_UNASKED_PREFIX}a saved rule refuses it.` });
  });

  it('answers a call nobody can approve with a refusal that says so, and raises no dead-end card', () => {
    const outcome = callTool(scheduledSessionArgs(hookFile), 'mcp__linear__save_issue', 'toolu_linear');
    expect(outcome).toHaveProperty('refused');
    const message = (outcome as { refused: string }).refused;
    expect(message.startsWith(HARNESS_UNASKED_PREFIX)).toBe(true);
    expect(message).toContain('mcp__linear__save_issue');
    expect(message).toContain('Auto-approve');
    expect(message).not.toContain("haven't granted it yet");
    expect(isPermissionDenialContent(message)).toBe(false);
  });

  it('a guarded Write still raises the allow-rule card, and the model is told a card was shown and a retry will work', () => {
    // Claude asks only about a write it would refuse (for example outside the project), so drive that ask directly.
    const settings = JSON.parse(scheduledSessionArgs(hookFile)[scheduledSessionArgs(hookFile).indexOf('--settings') + 1]) as { hooks: { PermissionRequest: Entry[] } };
    const entry = settings.hooks.PermissionRequest.find(item => new RegExp(item.matcher).test('Write'))!;
    const reply = runHook(entry.hooks[0].command, { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_use_id: 'toolu_write',
      tool_input: { file_path: '/outside/project/notes.md', content: 'x' }, permission_mode: 'acceptEdits' });
    const message = (reply?.['hookSpecificOutput'] as { decision: { behavior: string; message: string } }).decision.message;
    expect(message).toContain('Harness is showing the user a card for this call that can allow it');
    expect(message).toContain('trying again will then work');
    // The adapter still recognises the refusal and builds the same Write card from the call itself.
    expect(isPermissionDenialContent(message)).toBe(true);
    const contexts = new Map([['toolu_write', { name: 'Write', input: { file_path: '/outside/project/notes.md' } }]]);
    expect(extractPermissionDetails(message, 'toolu_write', contexts)).toMatchObject({ action: 'write', path: '/outside/project/notes.md' });
  });
});
